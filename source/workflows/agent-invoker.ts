import { join } from "node:path";
import type { AgavConfig, PermissionMode } from "../config/config.js";
import { getAgavDir, isEffortLevel } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";
import type { ConfirmResult } from "../agent/loop.js";
import type { AgentDefinition } from "../agents/types.js";
import { executeA2AAgent, executeNativeAgent } from "../agents/executor.js";
import { agentToolVerdict, SAFE_TOOLS } from "./gated-tools.js";

/** One isolated agent call from a workflow node. `task` is the whole user message: no conversation history. */
export interface AgentInvokeRequest {
  /** Installed agent; when absent a synthetic native agent is built from `systemPrompt` + `allowedTools`. */
  agent?: AgentDefinition;
  systemPrompt?: string;
  task: string;
  model?: string;
  effort?: string;
  maxIterations?: number;
  /** Built-in tool allowlist. For an installed native agent this only narrows its own `native-tools`. */
  allowedTools?: string[];
  signal: AbortSignal;
  confirmTool: (toolName: string, input: unknown) => Promise<boolean>;
  /** The run's (narrowed) permission mode; defaults to the invoker config's. */
  permissionMode?: PermissionMode;
  cwd: string;
}
export interface AgentInvokeResult { text: string; usage?: unknown; model?: string; durationMs: number }
export interface AgentInvoker { invoke(req: AgentInvokeRequest): Promise<AgentInvokeResult> }

export const PROMPT_AGENT_NAME = "workflow-prompt-agent";

/** Synthetic native agent for prompt-only nodes. Its path never holds a config.json, so no credentials or overrides load. */
export function buildPromptAgent(systemPrompt: string, allowedTools: string[] = []): AgentDefinition {
  return {
    manifest: { name: PROMPT_AGENT_NAME, description: "Workflow prompt node", version: "0.0.0", type: "native", "native-tools": [...allowedTools] },
    systemPrompt, tools: [], origin: "project", path: join(getAgavDir(), "workflows", PROMPT_AGENT_NAME),
  };
}

/** Clones the agent with per-node manifest overrides; the caller's definition is never mutated. */
function withOverrides(agent: AgentDefinition, req: AgentInvokeRequest): AgentDefinition {
  const manifest = { ...agent.manifest };
  if (req.model !== undefined) manifest.model = req.model;
  if (req.effort !== undefined) {
    if (!isEffortLevel(req.effort)) throw new Error(`Invalid effort level: ${req.effort}`);
    manifest.effort = req.effort;
  }
  if (req.allowedTools !== undefined) manifest["native-tools"] = (manifest["native-tools"] ?? []).filter(tool => req.allowedTools!.includes(tool));
  return { ...agent, manifest };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

/**
 * Settles with `promise` or rejects as soon as `signal` aborts. The A2A client takes no signal, so an
 * aborted remote call is only abandoned locally: the remote agent may keep running and its result is dropped.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => { signal.removeEventListener("abort", onAbort); });
  });
}

/** Boolean workflow consent -> loop ConfirmResult; never "always", so each call is decided individually. */
export function adaptConfirmTool(confirm: AgentInvokeRequest["confirmTool"]): (toolName: string, input: Record<string, unknown>) => Promise<ConfirmResult> {
  return async (toolName, input) => (await confirm(toolName, input)) ? "yes" : "no";
}

/**
 * Default invoker. Native and synthetic prompt agents run in-process via `executeNativeAgent`; model/effort
 * overrides are applied by cloning the manifest (an agent's own config.json model/effort still takes
 * precedence, as in `executeNativeAgent`). Tools run in the process cwd; `req.cwd` is not applied here.
 */
export function createDefaultAgentInvoker(deps: { provider: LLMProvider; config: AgavConfig }): AgentInvoker {
  return {
    async invoke(req) {
      const started = Date.now();
      if (req.signal.aborted) throw abortError(req.signal);
      const base = req.agent ?? (req.systemPrompt !== undefined ? buildPromptAgent(req.systemPrompt, req.allowedTools) : undefined);
      if (!base) throw new Error("Agent invocation requires an agent or a systemPrompt.");
      const type = base.manifest.type || "native";
      if (type === "a2a") {
        const text = await raceAbort(executeA2AAgent(base, req.task), req.signal);
        return { text, durationMs: Date.now() - started };
      }
      if (type !== "native") throw new Error(`Unsupported agent type: ${String(type)}`);
      const agent = withOverrides(base, req);
      const budget = req.maxIterations ?? deps.config.maxIterations;
      const mode = req.permissionMode ?? deps.config.permissionMode ?? "ask";
      const gateConfig: AgavConfig = { ...deps.config, permissionMode: mode };
      // Independent gate: refusals (destructive, deny-writes, config allowedTools incl. path rules) never reach the
      // caller's confirm and so cannot be overridden by it; everything else is still decided by req.confirmTool.
      const confirmTool: AgentInvokeRequest["confirmTool"] = async (toolName, input) => {
        const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
        const verdict = agentToolVerdict(toolName, args, gateConfig);
        if (verdict === "deny") return false;
        // Auto-accept approves what passed the gate itself, as the loop would have without the "ask" downgrade.
        if (mode === "auto-accept" && verdict === "allow") return true;
        return req.confirmTool(toolName, input);
      };
      const text = await executeNativeAgent(agent, req.task, {
        provider: deps.provider,
        config: deps.config,
        signal: req.signal,
        confirmTool: adaptConfirmTool(confirmTool),
        // The loop skips confirmation entirely under auto-accept, which would bypass the gate above; run it in
        // "ask" so every non-SAFE call reaches confirmTool (the caller's confirm applies auto-accept itself).
        permissionMode: mode === "auto-accept" ? "ask" : mode,
        // Tool lists only restrict; every non-SAFE sub-tool call goes through confirmTool.
        toolGate: { safeTools: SAFE_TOOLS },
        iterationsBudget: { remaining: budget, total: budget },
      });
      return { text, model: agent.manifest.model ?? deps.config.model, durationMs: Date.now() - started };
    },
  };
}
