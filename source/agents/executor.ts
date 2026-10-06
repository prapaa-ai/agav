/**
 * Agent executor - runs native and A2A agents
 */

import type { AgentDefinition } from "./types.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider } from "../providers/types.js";
import type { AgavConfig, PermissionMode } from "../config/config.js";
import { runAgentLoop } from "../agent/loop.js";



import { randomUUID } from "node:crypto";
import { loadAgentConfig, resolveAgentMcpEnv } from "./credentials.js";
import { getRequiredEnvVars } from "../mcp/env-vars.js";
import { resolveConfigDir } from "../components/agents-types.js";

// AgavHooks type - defined locally since it's not exported from hooks.js
interface AgavHooks {
  afterEdit?: string;
  afterShell?: string;
  preCommit?: string;
}

/**
 * Execute a native agent (JS/TS in-process)
 */
export async function executeNativeAgent(
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
    iterationsBudget?: { remaining: number, total: number }
  }
): Promise<string> {
  const callId = `${agent.manifest.name}-${randomUUID().slice(0, 8)}`;

  // Per-agent model/effort overrides (from per-agent config.json).
  const agentOverrides = await loadAgentConfig(resolveConfigDir(agent));

  const model  = agentOverrides["model"]  || agent.manifest.model  || deps.config.model;
  const effort = (agentOverrides["effort"] || agent.manifest.effort || deps.config.effort) as import("../config/config.js").EffortLevel;

  // Start per-agent MCP servers.
  // Env resolution: process.env < global/project config mcpServers[key].env < per-agent overrides.
  let agentMCPManager: import("../mcp/manager.js").MCPManager | null = null;
  const mcpServersDecl = agent.manifest["mcp-servers"] ?? [];

  // Extract per-agent MCP env overrides from agentOverrides (keys like "mcp:<serverKey>:<envKey>").
  const perAgentMcpOverrides: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(agentOverrides)) {
    const parts = k.split(":");
    if (parts.length === 3 && parts[0] === "mcp") {
      const srvKey = parts[1]!;
      if (!perAgentMcpOverrides[srvKey]) perAgentMcpOverrides[srvKey] = {};
      perAgentMcpOverrides[srvKey]![parts[2]!] = v;
    }
  }

  if (mcpServersDecl.length > 0) {
    const { MCPManager } = await import("../mcp/manager.js");
    agentMCPManager = new MCPManager();
    for (const srv of mcpServersDecl) {
      const globalServerEnv = deps.config.mcpServers?.[srv.key]?.env ?? {};
      const agentServerOverrides = { ...perAgentMcpOverrides[srv.key] };
      for (const key of agent.manifest["required-config"] ?? []) {
        if (agentOverrides[key] && !globalServerEnv[key] && !agentServerOverrides[key]) {
          agentServerOverrides[key] = agentOverrides[key];
        }
      }
      const allowedKeys = new Set([
        ...getRequiredEnvVars(srv.key, deps.config.mcpServers?.[srv.key] ?? {}).map((v) => v.name),
        ...(agent.manifest["required-config"] ?? []),
        ...Object.keys(agentServerOverrides),
      ]);
      const serverConfig = {
        command: srv.command,
        args: srv.args ?? [],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, v]) => v !== undefined && (!/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key) || allowedKeys.has(key)))) as Record<string, string>, ...globalServerEnv, ...agentServerOverrides },
      };
      try {
        await agentMCPManager.startServer(srv.key, serverConfig);
      } catch (err) {
        console.warn(`[agent:${agent.manifest.name}] Failed to start MCP server "${srv.key}":`, err);
      }
    }
  }

  // Collect env values from the agent's declared MCP servers for tool context.
  const agentMcpEnv = resolveAgentMcpEnv(agent.manifest, deps.config, agentOverrides);

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
        execute: (input, context) => tool.execute(input, { ...context, env: agentMcpEnv }),
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
      iterationsBudget: deps.iterationsBudget ?? { remaining: deps.config.maxIterations, total: deps.config.maxIterations },
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
      }
    }

    if (loopError && !output) {
      throw loopError;
    }

    return output || "Agent completed with no output.";
  } finally {
    deps.onProgressUpdate?.(callId, { type: "turn_complete" });

    if (agentMCPManager) {
      await agentMCPManager.stopAll();
    }
  }
}

/**
 * Execute an A2A agent (external process via HTTP)
 */
export async function executeA2AAgent(
  agent: AgentDefinition,
  task: string
): Promise<string> {
  const { executeA2AAgent: a2aExecute } = await import("./a2a-client.js");

  const output = await a2aExecute(agent, task);
  return output;
}
