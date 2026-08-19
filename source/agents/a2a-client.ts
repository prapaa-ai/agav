/**
 * A2A (Agent-to-Agent) protocol client
 * Implements Google's A2A protocol for communicating with external agents via HTTP
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentDefinition } from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLoopbackEndpoint(endpoint: string, allowRemote?: boolean): void {
  if (allowRemote) return;
  const parsed = new URL(endpoint);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `A2A endpoint "${endpoint}" is not loopback. Set "allow-remote-endpoint: true" in the manifest to allow remote endpoints.`
    );
  }
}

function parseCommandString(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of cmd) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue; }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { parts.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * A2A request format
 */
interface A2ARequest {
  task: string;
  context?: Record<string, unknown>;
}

/**
 * A2A response format
 */
interface A2AResponse {
  output: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * A2A event types for streaming
 */
type A2AEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "error"; error: string }
  | { type: "done"; output: string };

/**
 * Managed A2A agent process
 */
interface ManagedA2AAgent {
  agent: AgentDefinition;
  process: ChildProcess;
  endpoint: string;
  ready: boolean;
}

/**
 * Registry of managed A2A agent processes
 */
const managedAgents = new Map<string, ManagedA2AAgent>();

/**
 * Start an A2A agent process if it has a start-command
 */
export async function startA2AAgent(agent: AgentDefinition): Promise<{ success: boolean; error?: string }> {
  const key = agent.alias || agent.manifest.name;

  // Already running
  if (managedAgents.has(key)) {
    return { success: true };
  }

  const startCommand = agent.manifest["start-command"];
  if (!startCommand) {
    return { success: false, error: "No start-command defined for A2A agent" };
  }

  const endpoint = agent.manifest.endpoint;
  if (!endpoint) {
    return { success: false, error: "No endpoint defined for A2A agent" };
  }

  try {
    assertLoopbackEndpoint(endpoint, (agent.manifest as any)["allow-remote-endpoint"]);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Parse command and args (handles simple quoting)
  const parts = parseCommandString(startCommand);
  const command = parts[0]!;
  const args = parts.slice(1);

  try {
    const proc = spawn(command, args, {
      cwd: agent.path,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (data) => {
      // Log stdout for debugging
      console.error(`[A2A ${key}] ${data.toString()}`);
    });

    proc.stderr?.on("data", (data) => {
      console.error(`[A2A ${key}] ERROR: ${data.toString()}`);
    });

    proc.on("exit", (code) => {
      console.error(`[A2A ${key}] Process exited with code ${code}`);
      managedAgents.delete(key);
    });

    managedAgents.set(key, {
      agent,
      process: proc,
      endpoint,
      ready: false,
    });

    // Wait for agent to be ready (health check)
    const ready = await waitForAgent(endpoint, 10000);
    if (!ready) {
      proc.kill();
      managedAgents.delete(key);
      return { success: false, error: "Agent failed to start (health check timeout)" };
    }

    const managed = managedAgents.get(key);
    if (managed) {
      managed.ready = true;
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to start A2A agent: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Wait for an A2A agent to become ready by polling its health endpoint
 */
async function waitForAgent(endpoint: string, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  const healthUrl = `${endpoint}/health`;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { method: "GET", signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // Agent not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

/**
 * Stop an A2A agent process
 */
export function stopA2AAgent(nameOrAlias: string): void {
  const managed = managedAgents.get(nameOrAlias);
  if (managed) {
    managed.process.kill();
    managedAgents.delete(nameOrAlias);
  }
}

/**
 * Stop all managed A2A agent processes
 */
export function stopAllA2AAgents(): void {
  for (const [, managed] of managedAgents.entries()) {
    managed.process.kill();
  }
  managedAgents.clear();
}

/**
 * Execute a task on an A2A agent
 */
export async function executeA2AAgent(
  agent: AgentDefinition,
  task: string,
  context?: Record<string, unknown>
): Promise<string> {
  const key = agent.alias || agent.manifest.name;

  // Ensure agent is started
  let managed = managedAgents.get(key);
  if (!managed || !managed.ready) {
    const startResult = await startA2AAgent(agent);
    if (!startResult.success) {
      throw new Error(startResult.error || "Failed to start A2A agent");
    }
    managed = managedAgents.get(key);
    if (!managed) {
      throw new Error("Agent started but not found in registry");
    }
  }

  const endpoint = managed.endpoint;

  // Make A2A request
  const request: A2ARequest = { task, context };

  try {
    const response = await fetch(`${endpoint}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`A2A agent returned ${response.status}: ${response.statusText}`);
    }

    const result = await response.json() as A2AResponse;

    if (result.isError) {
      throw new Error(result.output);
    }

    return result.output;
  } catch (error) {
    throw new Error(
      `A2A execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Execute a task on an A2A agent with streaming support
 */
export async function* executeA2AAgentStreaming(
  agent: AgentDefinition,
  task: string,
  context?: Record<string, unknown>
): AsyncGenerator<A2AEvent> {
  const key = agent.alias || agent.manifest.name;

  // Ensure agent is started
  let managed = managedAgents.get(key);
  if (!managed || !managed.ready) {
    const startResult = await startA2AAgent(agent);
    if (!startResult.success) {
      yield { type: "error", error: startResult.error || "Failed to start A2A agent" };
      return;
    }
    managed = managedAgents.get(key);
    if (!managed) {
      yield { type: "error", error: "Agent started but not found in registry" };
      return;
    }
  }

  const endpoint = managed.endpoint;
  const request: A2ARequest = { task, context };

  try {
    const response = await fetch(`${endpoint}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      yield {
        type: "error",
        error: `A2A agent returned ${response.status}: ${response.statusText}`,
      };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "No response body from A2A agent" };
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            return;
          }

          try {
            const event: A2AEvent = JSON.parse(data);
            yield event;
          } catch {
            // Invalid JSON, skip
          }
        }
      }
    }
  } catch (error) {
    yield {
      type: "error",
      error: `A2A streaming failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
