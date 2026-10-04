/**
 * A2A (Agent-to-Agent) protocol client
 * Implements Google's A2A protocol for communicating with external agents via HTTP
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentDefinition } from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLoopbackEndpoint(endpoint: string): void {
  const parsed = new URL(endpoint);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `A2A endpoint "${endpoint}" is not loopback. A2A endpoints must be loopback (127.0.0.1/localhost/::1). Remote endpoints are not supported.`
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

/** Token accounting reported by an A2A agent, when it provides it. */
export interface A2AUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Token budget an A2A agent reports for itself.
 *
 * External agents run outside this process, so their consumption cannot be
 * measured directly. An agent that wants to surface a budget may report it; one
 * that does not is left with `undefined` so the gap is visible rather than
 * silently treated as zero.
 */
export interface A2ATokenBudget {
  /** Total token allowance the agent is operating under. */
  limit?: number;
  /** Tokens consumed so far, if the agent tracks it. */
  used?: number;
  /** Tokens left, if the agent can compute it. */
  remaining?: number;
  /** Budget window, e.g. "run", "day", "session". */
  period?: string;
}

export const EMPTY_A2A_USAGE: A2AUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/**
 * Extract usage from A2A response metadata when the agent reports it.
 * Returns zeroed usage when absent, so callers can always accumulate safely.
 */
export function readA2AUsage(metadata: Record<string, unknown> | undefined): A2AUsage {
  const source = a2aUsageSource(metadata);
  if (!source) return { ...EMPTY_A2A_USAGE };
  return {
    inputTokens: readNumber(source.inputTokens),
    outputTokens: readNumber(source.outputTokens),
    cacheReadTokens: readNumber(source.cacheReadTokens),
    cacheWriteTokens: readNumber(source.cacheWriteTokens),
  };
}

/**
 * Whether the agent actually reported usage.
 *
 * This matters because a missing report and a reported zero are different
 * facts. Callers should not present unreported external usage as a real zero.
 */
export function hasA2AUsage(metadata: Record<string, unknown> | undefined): boolean {
  return a2aUsageSource(metadata) !== undefined;
}

/**
 * Read an optional token budget reported by an external agent.
 *
 * Returns `undefined` when the agent reports no budget, so callers can show an
 * explicit "no budget returned" state instead of inventing a number.
 */
export function readA2ATokenBudget(metadata: Record<string, unknown> | undefined): A2ATokenBudget | undefined {
  if (!metadata) return undefined;

  const candidates = [metadata.tokenBudget, metadata.budget, metadata.token_budget];
  const raw = candidates.find((value) => value && typeof value === "object");
  if (!raw) return undefined;

  const source = raw as Record<string, unknown>;
  const budget: A2ATokenBudget = {};
  const limit = readOptionalNumber(source.limit ?? source.maxTokens ?? source.total);
  const used = readOptionalNumber(source.used ?? source.consumed ?? source.spent);
  const remaining = readOptionalNumber(source.remaining ?? source.left);
  const period = typeof source.period === "string" ? source.period : undefined;

  if (limit !== undefined) budget.limit = limit;
  if (used !== undefined) budget.used = used;
  if (remaining !== undefined) budget.remaining = remaining;
  if (period !== undefined) budget.period = period;

  // An object with no usable numbers is treated as no budget rather than an
  // empty budget, so the caller can flag it.
  if (budget.limit === undefined && budget.used === undefined && budget.remaining === undefined) {
    return undefined;
  }
  return budget;
}

/** Render a budget for display, or an explicit marker when none was returned. */
export function formatA2ATokenBudget(budget: A2ATokenBudget | undefined): string {
  if (!budget) return "No token budget returned";
  const parts: string[] = [];
  if (budget.limit !== undefined) parts.push(`limit ${budget.limit}`);
  if (budget.used !== undefined) parts.push(`used ${budget.used}`);
  if (budget.remaining !== undefined) parts.push(`remaining ${budget.remaining}`);
  if (parts.length === 0) return "No token budget returned";
  const summary = parts.join(", ");
  return budget.period ? `${summary} (${budget.period})` : summary;
}

function a2aUsageSource(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const explicit = metadata.usage ?? metadata.tokenUsage ?? metadata.token_usage;
  if (explicit && typeof explicit === "object") return explicit as Record<string, unknown>;

  // Fall back to flat metadata, but only when it actually carries token fields
  // so unrelated metadata is not mistaken for usage.
  const flatKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
  return flatKeys.some((key) => key in metadata) ? metadata : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    assertLoopbackEndpoint(endpoint);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Parse command and args (handles simple quoting)
  const parts = parseCommandString(startCommand);
  const command = parts[0]!;
  const args = parts.slice(1);

  try {
    // TODO: start-command is unreviewed execution from a downloaded manifest.
    // Add user confirmation at install or first run.
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
 * Execute a task on an A2A agent, returning output and any reported usage.
 */
export async function executeA2AAgentDetailed(
  agent: AgentDefinition,
  task: string,
  context?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ output: string; usage: A2AUsage; usageReported: boolean; tokenBudget?: A2ATokenBudget }> {
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
      signal: signal ?? AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`A2A agent returned ${response.status}: ${response.statusText}`);
    }

    const result = await response.json() as A2AResponse;

    if (result.isError) {
      throw new Error(result.output);
    }

    // External agents are out of process, so their consumption is whatever
    // they choose to report. Both facts are surfaced so a missing report is
    // never mistaken for genuinely zero usage.
    return {
      output: result.output,
      usage: readA2AUsage(result.metadata),
      usageReported: hasA2AUsage(result.metadata),
      tokenBudget: readA2ATokenBudget(result.metadata),
    };
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
