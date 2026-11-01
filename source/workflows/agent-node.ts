import { join } from "node:path";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { writeAtomic } from "../background-jobs/storage/atomic-file.js";
import type { AgentInvoker, AgentInvokeRequest } from "./agent-invoker.js";
import type { WorkflowNode } from "./definition.js";
import { DecisionPendingError, waitForDecision } from "./decisions.js";
import { confirmAgentTool } from "./gated-tools.js";
import { resolveTemplate, type TemplateContext } from "./interpolate.js";
import { parseNodeOutput } from "./structured-output.js";
import type { NodeCheckpoint, WorkflowRun, WorkflowStore } from "./store.js";
import type { NodeExecutionContext, NodeExecutor, NodeResult } from "./executors.js";

/** Trusted dependencies for agent/prompt nodes; tests inject a mock invoker and fake agents. */
export interface AgentNodeDeps {
  /** Built lazily so runs without agent nodes never need provider credentials. */
  getInvoker(config: AgavConfig): AgentInvoker;
  /** Defaults to `loadAgents` from source/agents/loader.ts. */
  loadAgents?: (cwd: string) => Promise<AgentDefinition[]>;
  /** Poll interval while an agent sub-tool waits on an inbox decision (default 200 ms). */
  decisionPollMs?: number;
}

/** System prompt of the synthetic agent behind `prompt` nodes; the node's prompt is the (only) user message. */
export const PROMPT_NODE_SYSTEM_PROMPT = "You are a step in an automated workflow. Complete the task in the user message and reply with the result only.";

/** Interpolation context from run inputs and node checkpoints, plus the enclosing loop's context when given. */
export function templateContext(run: WorkflowRun, loop?: TemplateContext["loop"], scopeNodes?: Record<string, NodeCheckpoint>): TemplateContext {
  return { inputs: run.inputs, nodes: Object.fromEntries((scopeNodes ? Object.values(scopeNodes) : run.nodes).map(cp => [cp.id, { status: cp.status, output: cp.output }])), ...(loop ? { loop } : {}) };
}

/** `<runDir>/artifacts/<nodeId>.txt`, next to the overflow `<nodeId>.json` artifacts. */
export function transcriptRelativePath(nodeId: string): string { return `artifacts/${nodeId}.txt`; }

async function writeTranscript(store: WorkflowStore, run: WorkflowRun, node: WorkflowNode, task: string, body: string): Promise<void> {
  const text = `# Workflow ${run.definition.name} - run ${run.id} - node ${node.id} (${node.type}${node.agent ? `: ${node.agent}` : ""})\n\n## Task\n\n${task}\n\n${body}\n`;
  try { await writeAtomic(join(store.runDir(run.id), transcriptRelativePath(node.id)), text); }
  catch { /* the transcript is a log; a failed write never changes the node outcome */ }
}

/** True when an interrupted (running) agent/prompt node may simply be dispatched again on resume. */
export function agentNodeRetrySafe(node: WorkflowNode): boolean {
  return (node.type === "agent" || node.type === "prompt") && node.retrySafe !== false;
}

async function resolveAgent(deps: AgentNodeDeps, cwd: string, name: string): Promise<AgentDefinition> {
  const load = deps.loadAgents ?? (async (dir: string) => (await import("../agents/loader.js")).loadAgents(dir));
  const agents = await load(cwd);
  const agent = agents.find(item => item.manifest.name === name);
  if (!agent) throw new Error(`Unknown agent "${name}" (installed: ${agents.map(item => item.manifest.name).join(", ") || "none"}).`);
  if (agent.manifest.enabled === false) throw new Error(`Agent "${name}" is disabled.`);
  return agent;
}

/**
 * Runs one agent or prompt node: the interpolated task is the agent's whole input (no conversation history).
 * Sub-tool confirmations go through `confirmAgentTool`; a background host's pending decision is awaited
 * in-process (the conversation cannot be parked), and a deny only refuses that call.
 */
async function executeAgentNode(ctx: NodeExecutionContext): Promise<NodeResult> {
  const { store, run, node, checkpoint: cp, config, signal, host, agentDeps } = ctx;
  cp.status = "running"; cp.startedAt = new Date().toISOString();
  for (const key of ["output", "error", "usage", "model", "durationMs", "endedAt"] as const) delete cp[key];
  await store.save(run);
  const child = new AbortController();
  const abortChild = (): void => { child.abort(signal.reason); };
  signal.addEventListener("abort", abortChild, { once: true });
  if (signal.aborted) abortChild();
  let timedOut = false;
  const timeout = node.timeoutSeconds === undefined ? undefined : setTimeout(() => {
    timedOut = true; child.abort(new Error(`Node ${node.id} timed out after ${node.timeoutSeconds}s.`));
  }, node.timeoutSeconds * 1000);
  let task = "";
  try {
    if (!agentDeps) throw new Error("Agent nodes unavailable: this execution context supplies no agent invoker.");
    task = String(resolveTemplate(node.type === "agent" ? node.task! : node.prompt!, templateContext(run, ctx.loop, ctx.scopeNodes)));
    const agent = node.type === "agent" ? await resolveAgent(agentDeps, run.cwd, node.agent!) : undefined;
    // A2A agents run remotely and take only the task: per-node overrides would be silently ignored, so refuse them.
    if (agent?.manifest.type === "a2a") {
      const overrides = (["model", "effort", "maxIterations"] as const).filter(field => node[field] !== undefined);
      if (overrides.length > 0) throw new Error(`Agent "${agent.manifest.name}" is an a2a agent; ${overrides.join(", ")} cannot be applied to remote agents. Remove ${overrides.length > 1 ? "them" : "it"} from node ${node.id}.`);
    }
    const confirmTool: AgentInvokeRequest["confirmTool"] = async (toolName, input) => {
      const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
      try {
        return await confirmAgentTool(toolName, args, config, child.signal, host, { nodeId: node.id, ...(ctx.iteration ? { iteration: ctx.iteration } : {}) });
      } catch (error) {
        if (!(error instanceof DecisionPendingError)) throw error;
        return waitForDecision(store, run.id, error.decision.decisionId, child.signal, agentDeps.decisionPollMs);
      }
    };
    const request: AgentInvokeRequest = {
      task, signal: child.signal, confirmTool, permissionMode: config.permissionMode, cwd: run.cwd,
      ...(agent ? { agent } : { systemPrompt: PROMPT_NODE_SYSTEM_PROMPT, allowedTools: [...(node.allowedTools ?? [])] }),
      ...(node.model !== undefined ? { model: node.model } : {}),
      ...(node.effort !== undefined ? { effort: node.effort } : {}),
      ...(node.maxIterations !== undefined ? { maxIterations: node.maxIterations } : {}),
    };
    const result = await agentDeps.getInvoker(config).invoke(request);
    if (result.usage !== undefined) cp.usage = result.usage;
    if (result.model !== undefined) cp.model = result.model;
    cp.durationMs = result.durationMs;
    await writeTranscript(store, run, node, task, `## Reply\n\n${result.text}`);
    if (timedOut || signal.aborted) {
      cp.status = timedOut ? "timed_out" : "cancelled";
      cp.error = timedOut ? `Timed out after ${node.timeoutSeconds}s.` : "Cancelled.";
    } else {
      const parsed = parseNodeOutput(result.text, node.output ?? "text", node.outputSchema);
      if (parsed.ok) { cp.output = parsed.value; cp.status = "passed"; }
      else { cp.status = "failed"; cp.error = parsed.error; }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cp.status = timedOut ? "timed_out" : signal.aborted ? "cancelled" : "failed";
    cp.error = timedOut ? `Timed out after ${node.timeoutSeconds}s.` : message;
    if (task) await writeTranscript(store, run, node, task, `## Error\n\n${message}`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener("abort", abortChild);
  }
  cp.endedAt = new Date().toISOString();
  await store.save(run);
  return { next: cp.status === "passed" ? "continue" : "stop" };
}

export const agentExecutor: NodeExecutor = { type: "agent", retryOnResume: agentNodeRetrySafe, execute: executeAgentNode };
export const promptExecutor: NodeExecutor = { type: "prompt", retryOnResume: agentNodeRetrySafe, execute: executeAgentNode };
