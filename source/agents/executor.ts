/**
 * Agent executor - runs native and A2A agents
 */

import type { AgentDefinition } from "./types.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider } from "../providers/types.js";
import type { AgavConfig, PermissionMode } from "../config/config.js";
import { runAgentLoop } from "../agent/loop.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decrypt } from "../utils/encrypt.js";

/** Token accounting for a single agent invocation. */
export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentRunResult {
  output: string;
  usage: AgentRunUsage;
  /**
   * For external (A2A) agents: whether the agent actually reported usage.
   * False means the agent returned nothing, not that it used zero tokens.
   */
  usageReported?: boolean;
  /** Token budget the external agent reported for itself, when provided. */
  tokenBudget?: { limit?: number; used?: number; remaining?: number; period?: string };
}

export function emptyAgentUsage(): AgentRunUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

// AgavHooks type - defined locally since it's not exported from hooks.js
interface AgavHooks {
  afterEdit?: string;
  afterShell?: string;
  preCommit?: string;
}

/**
 * Load agent credentials from config.json.
 * Tries the agent's own path first, then falls back to the global
 * ~/.agav/agents/<name> path so bundled agents can be configured
 * without touching the app's source directory.
 */
async function loadAgentCredentials(agentPath: string, agentName?: string): Promise<Record<string, string>> {
  const paths = [agentPath];

  if (agentName) {
    const { homedir } = await import("node:os");
    const globalPath = join(homedir(), ".agav", "agents", agentName);
    if (globalPath !== agentPath) paths.push(globalPath);
  }

  for (const p of paths) {
    const configPath = join(p, "config.json");
    try {
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);

      const decrypted: Record<string, string> = {};
      for (const [key, value] of Object.entries(config)) {
        if (typeof value === "string") {
          try {
            decrypted[key] = decrypt(value);
          } catch {
            // Not encrypted, use as-is
            decrypted[key] = value;
          }
        }
      }

      if (Object.keys(decrypted).length > 0) return decrypted;
    } catch {
      // No config.json at this path — try next
    }
  }

  return {};
}

/**
 * Execute a native agent and report token usage alongside the output.
 */
export async function executeNativeAgentDetailed(
  agent: AgentDefinition,
  task: string,
  deps: {
    provider: LLMProvider;
    config: AgavConfig;
    hooks?: AgavHooks;
    signal?: AbortSignal;
    /** Called for each AgentEvent emitted by the child loop, keyed by a per-invocation callId. */
    onProgressUpdate?: (callId: string, event: import("../agent/loop.js").AgentEvent) => void | Promise<void>;
    /** Parent's confirmTool — when provided, agent sub-tools that are marked
     *  destructive will pause and surface HITL confirmation to the user. */
    confirmTool?: (toolName: string, input: Record<string, unknown>, diff?: any[]) => Promise<import("../agent/loop.js").ConfirmResult>;
    /** Explicit mode for direct executions such as a full-access agent lock. */
    permissionMode?: PermissionMode;
    /** Deduplicates a retried invocation of the same logical unit of work. */
    idempotencyKey?: string;
  }
): Promise<AgentRunResult> {
  const callId = `${agent.manifest.name}-${randomUUID().slice(0, 8)}`;

  // Load per-agent runtime config: credentials + optional model/effort overrides.
  // Priority: config.json > AGENT.md manifest > session config.
  const runtimeConfig = await loadAgentCredentials(agent.path, agent.manifest.name);

  const model  = runtimeConfig["model"]  || agent.manifest.model  || deps.config.model;
  const effort = (runtimeConfig["effort"] || agent.manifest.effort || deps.config.effort) as import("../config/config.js").EffortLevel;

  // Start per-agent MCP servers (credentials passed via subprocess env, not process.env)
  let agentMCPManager: import("../mcp/manager.js").MCPManager | null = null;
  const mcpServersDecl = agent.manifest["mcp-servers"] ?? [];
  if (mcpServersDecl.length > 0) {
    const { MCPManager } = await import("../mcp/manager.js");
    agentMCPManager = new MCPManager();
    for (const srv of mcpServersDecl) {
      const serverConfig = {
        command: srv.command,
        args: srv.args ?? [],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>, ...srv.env, ...runtimeConfig },
      };
      try {
        await agentMCPManager.startServer(srv.key, serverConfig);
      } catch (err) {
        console.warn(`[agent:${agent.manifest.name}] Failed to start MCP server "${srv.key}":`, err);
      }
    }
  }

  try {
    // Wrap each tool's execute to inject credentials via context, not process.env.
    // Tools access credentials via process.env during their execute() call only.
    const childRegistry = new ToolRegistry();
    const nativeTools = agent.manifest["native-tools"] ?? [];
    if (nativeTools.length > 0) {
      const { createBuiltinToolRegistry } = await import("../tools/registry-factory.js");
      for (const tool of createBuiltinToolRegistry(nativeTools).list()) {
        childRegistry.register(tool);
      }
    }
    for (const tool of agent.tools) {
      childRegistry.register({
        schema: tool.schema,
        // Forward the whole context so signal and any future fields reach the tool.
        // The idempotency key is scoped per tool so distinct calls within one node
        // cannot collide with each other.
        execute: (input, context) =>
          tool.execute(input, {
            ...context,
            env: runtimeConfig,
            idempotencyKey: deps.idempotencyKey
              ? `${deps.idempotencyKey}:${tool.schema.name}`
              : undefined,
          }),
      });
    }

    if (agentMCPManager) {
      for (const tool of agentMCPManager.getToolDefinitions()) {
        childRegistry.register(tool);
      }
    }

    const conversation = new ConversationState();
    conversation.addUserMessage(task);

    const base = deps.config.systemPrompt ?? "";
    const systemPrompt = base ? `${base}\n\n${agent.systemPrompt}` : agent.systemPrompt;

    let output = "";
    let loopError: Error | null = null;
    const usage = emptyAgentUsage();

    const loopGenerator = runAgentLoop({
      provider: deps.provider,
      conversation,
      toolRegistry: childRegistry,
      model,
      systemPrompt,
      effort,
      maxTokens: deps.config.maxTokens,
      signal: deps.signal,
      confirmTool: deps.confirmTool ?? (deps.permissionMode === "auto-accept" ? async () => "yes" : undefined),
      permissionMode: deps.permissionMode ?? (deps.confirmTool ? "ask" : "deny-writes"),
      maxIterations: 50,
      allowedTools: nativeTools,
      hooks: deps.hooks,
    });

    for await (const event of loopGenerator) {
      await deps.onProgressUpdate?.(callId, event);

      if (event.type === "streaming_text") {
        output += event.text;
      } else if (event.type === "assistant_message_complete") {
        if (!output && event.text) {
          output = event.text;
        }
      } else if (event.type === "error") {
        loopError = event.error;
      } else if (event.type === "usage") {
        usage.inputTokens += event.inputTokens;
        usage.outputTokens += event.outputTokens;
        usage.cacheReadTokens += event.cacheReadTokens ?? 0;
        usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
      }
    }

    if (loopError && !output) {
      throw loopError;
    }

    return { output: output || "Agent completed with no output.", usage };
  } finally {
    deps.onProgressUpdate?.(callId, { type: "turn_complete" });

    if (agentMCPManager) {
      await agentMCPManager.stopAll();
    }
  }
}

/**
 * Execute a native agent, returning only its output text.
 *
 * Callers that need token accounting should use executeNativeAgentDetailed.
 */
export async function executeNativeAgent(
  agent: AgentDefinition,
  task: string,
  deps: Parameters<typeof executeNativeAgentDetailed>[2],
): Promise<string> {
  const result = await executeNativeAgentDetailed(agent, task, deps);
  return result.output;
}

/**
 * Execute an A2A agent and report any usage the agent returned.
 */
export async function executeA2AAgentDetailed(
  agent: AgentDefinition,
  task: string,
  options: { signal?: AbortSignal; context?: Record<string, unknown> } = {},
): Promise<AgentRunResult> {
  const { executeA2AAgentDetailed: a2aExecute } = await import("./a2a-client.js");

  const result = await a2aExecute(agent, task, options.context, options.signal);
  return {
    output: result.output,
    usage: result.usage,
    usageReported: result.usageReported,
    tokenBudget: result.tokenBudget,
  };
}

/**
 * Execute an A2A agent, returning only its output text.
 */
export async function executeA2AAgent(
  agent: AgentDefinition,
  task: string,
  options: { signal?: AbortSignal; context?: Record<string, unknown> } = {},
): Promise<string> {
  const result = await executeA2AAgentDetailed(agent, task, options);
  return result.output;
}
