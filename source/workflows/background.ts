import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgavConfig } from "../config/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import { isSandboxRequired } from "../utils/sandbox.js";
import type { WorkflowDefinition } from "./definition.js";
import { buildConsent, consentSession } from "./grant.js";
import { resolveInputs } from "./inputs.js";
import type { JobCoordinatorLike, JobNodeDeps } from "./job-node.js";
import { launchRun, updateRun, type LaunchResult, type RunnerCoordinator } from "./launch.js";
import { reconcileRun, reconcileRuns } from "./reconcile.js";
import type { ConsentRequest } from "./consent-prompt.js";
import { createRun } from "./runtime.js";
import { listPendingDecisions } from "./decisions.js";
import type { WorkflowRun, WorkflowStore } from "./store.js";
import { formatDecision, formatRunSummary, formatRunTree, shortId, truncateOutput } from "./format.js";

export { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from "./format.js";

/** The CLI entry script the runner re-executes (`node <cli> --internal-workflow-runner <id>`).
 * In a Bun standalone binary this is a virtual `/$bunfs/...` path that launch ignores (the binary re-executes itself). */
export async function cliEntryPath(argv1: string | undefined = process.argv[1]): Promise<string> {
  if (!argv1) throw new Error("Cannot resolve the agav CLI entry script (process.argv[1] is empty).");
  const path = resolve(argv1);
  return realpath(path).catch(() => path);
}

export { assertBackgroundRunsAvailable } from "./launch.js";

export interface PreparedLaunch { definition: WorkflowDefinition; inputs: Record<string, unknown>; cwd: string; request: ConsentRequest }

/** Validates inputs and builds what the consent prompt shows; nothing is persisted yet. */
export async function prepareLaunch(definition: WorkflowDefinition, inputs: Record<string, unknown>, workflowName: string, config: Pick<AgavConfig, "permissionMode">, envNames: string[]): Promise<PreparedLaunch> {
  resolveInputs(definition, inputs); // fail before asking for consent
  const cwd = await realpath(process.cwd());
  const preview = buildConsent(definition, cwd, config.permissionMode, []);
  return { definition, inputs, cwd, request: { workflowName, cwd, permissionMode: config.permissionMode, capabilities: preview.capabilities, envNames } };
}

export interface StartRunDeps { coordinator: RunnerCoordinator; cliPath: string; maxConcurrentWorkflowRuns?: number; registry?: ToolRegistry; sandboxRequired?: boolean }

/** Creates the background run with its per-invocation consent (env NAMES only) and launches its runner. */
export async function startBackgroundRun(store: WorkflowStore, prepared: PreparedLaunch, permissionMode: AgavConfig["permissionMode"], envNames: string[], deps: StartRunDeps & { registry: ToolRegistry }): Promise<LaunchResult> {
  const created = await createRun(store, prepared.definition, prepared.inputs, { host: "background" });
  const consent = buildConsent(prepared.definition, created.cwd, permissionMode, envNames);
  // The detached runner only reloads disk config, so the parent's effective requirement (e.g. `--sandbox-required`) is persisted.
  const sandboxRequired = deps.sandboxRequired === true || isSandboxRequired();
  await updateRun(store, created.id, deps.registry, run => { run.consent = consent; if (sandboxRequired) run.sandboxRequired = true; });
  return launchRun(store, created.id, { ...deps, sandboxRequired });
}

/** One-line launch summary with the follow-up hints. */
export function launchSummary(result: LaunchResult, prefix = "agav workflows"): string {
  const id = result.run.id, short = shortId(id);
  const state = result.status === "queued" ? `queued (${result.reason ?? "workflow runner pool full"})` : result.status;
  return `Workflow run ${id} (${result.run.definition.name}) ${state} · status: ${prefix} status ${short} · cancel: ${prefix} cancel ${short}`;
}

/**
 * Job deps for cancelling a consented run: the run's own consent covers stopping its runner and its jobs
 * (the user asked for this exact run to stop). Runs without consent keep the no-approval headless session.
 */
export function cancelJobDeps(run: WorkflowRun, getCoordinator: () => Promise<JobCoordinatorLike>, sandboxRequired: boolean, permissionMode: AgavConfig["permissionMode"]): JobNodeDeps {
  return {
    getCoordinator,
    session: run.consent ? consentSession(run.consent, ["stop"]) : { permissionMode, headlessApprovedActions: [] },
    sandboxRequired,
    headless: true,
  };
}

/** Reconciles one run, reporting (not throwing) failures so status still shows the checkpoint. */
export async function reconcileQuietly(store: WorkflowStore, runId: string | undefined, deps: StartRunDeps, warn: (message: string) => void): Promise<void> {
  try {
    if (runId) await reconcileRun(store, runId, deps);
    // reconcileRuns reports per-run errors as `none` with a reason instead of throwing.
    else for (const result of await reconcileRuns(store, deps)) if (result.action === "none" && result.reason) warn(`reconcile ${result.runId}: ${result.reason}`);
  } catch (error) {
    warn(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Runs newest first; unreadable checkpoints are skipped. */
export async function listRuns(store: WorkflowStore, registry: ToolRegistry): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  for (const id of await store.listIds()) {
    const run = await store.read(id, registry).catch(() => undefined);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** One concise line per pending inbox decision (all runs when `runId` is omitted). */
export async function inboxLines(store: WorkflowStore, runId?: string): Promise<string[]> {
  return (await listPendingDecisions(store, runId)).map(formatDecision);
}

/** Parses `[--note <text...>]`: the note is the remainder after `--note`. */
export function parseDecisionArgs(rest: string[]): { note?: string } {
  if (rest.length === 0) return {};
  if (rest[0] !== "--note" || rest.length < 2) throw new Error("Expected: <run-id> <node-id|decision-id> [--note <text>]");
  return { note: rest.slice(1).join(" ") };
}

/** Aliases kept for callers; the implementations live in format.ts. */
export const runLine = (run: WorkflowRun): string => formatRunSummary(run);
export const runSummary = (run: WorkflowRun): string => formatRunTree(run);
export const summarizeOutput = truncateOutput;
