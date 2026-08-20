/**
 * Agent executor - runs native and A2A agents
 */

import type { AgentDefinition } from "./types.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import { runAgentLoop } from "../agent/loop.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decrypt } from "../utils/encrypt.js";

// Mutex to serialize process.env mutations across concurrent agent calls
let envLockQueue: Promise<void> = Promise.resolve();
function acquireEnvLock(): Promise<() => void> {
  let release: () => void;
  const prev = envLockQueue;
  envLockQueue = new Promise<void>((resolve) => { release = resolve; });
  return prev.then(() => release!);
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
 * Execute a native agent (JS/TS in-process)
 */
export async function executeNativeAgent(
  agent: AgentDefinition,
  task: string,
  deps: {
    provider: LLMProvider;
    config: AgavConfig;
    hooks?: AgavHooks;
    /** Called for each AgentEvent emitted by the child loop, keyed by a per-invocation callId. */
    onProgressUpdate?: (callId: string, event: import("../agent/loop.js").AgentEvent) => void;
    /** Parent's confirmTool — when provided, agent sub-tools that are marked
     *  destructive will pause and surface HITL confirmation to the user. */
    confirmTool?: (toolName: string, input: Record<string, unknown>, diff?: any[]) => Promise<import("../agent/loop.js").ConfirmResult>;
  }
): Promise<string> {
  const callId = `${agent.manifest.name}-${randomUUID().slice(0, 8)}`;

  // Load per-agent runtime config: credentials + optional model/effort overrides.
  // Priority: config.json > AGENT.md manifest > session config.
  const runtimeConfig = await loadAgentCredentials(agent.path, agent.manifest.name);

  const model  = runtimeConfig["model"]  || agent.manifest.model  || deps.config.model;
  const effort = (runtimeConfig["effort"] || agent.manifest.effort || deps.config.effort) as import("../config/config.js").EffortLevel;

  // Narrow lock scope: hold the env lock only during MCP server startup,
  // then restore env and release before running the agent loop.
  let agentMCPManager: import("../mcp/manager.js").MCPManager | null = null;
  const releaseEnvLock = await acquireEnvLock();
  try {
    const originalEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(runtimeConfig)) {
      originalEnv[key] = process.env[key];
      process.env[key] = value;
    }

    try {
      const mcpServersDecl = agent.manifest["mcp-servers"] ?? [];
      if (mcpServersDecl.length > 0) {
        const { MCPManager } = await import("../mcp/manager.js");
        agentMCPManager = new MCPManager();
        for (const srv of mcpServersDecl) {
          const serverConfig = {
            command: srv.command,
            args: srv.args ?? [],
            env: { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>, ...runtimeConfig },
          };
          try {
            await agentMCPManager.startServer(srv.key, serverConfig);
          } catch (err) {
            console.warn(`[agent:${agent.manifest.name}] Failed to start MCP server "${srv.key}":`, err);
          }
        }
      }
    } finally {
      // Restore env vars as soon as MCP servers have spawned (they inherit env at spawn time)
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  } finally {
    releaseEnvLock();
  }

  // Agent loop runs without holding the env lock
  try {
    const childRegistry = new ToolRegistry();
    for (const tool of agent.tools) {
      childRegistry.register(tool);
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
      confirmTool: deps.confirmTool,
      permissionMode: deps.confirmTool ? "ask" : "deny-writes",
      maxIterations: 50,
      hooks: deps.hooks,
    });

    for await (const event of loopGenerator) {
      deps.onProgressUpdate?.(callId, event);

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
