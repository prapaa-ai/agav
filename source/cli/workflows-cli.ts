import { loadConfig, type AgavConfig } from "../config/config.js";
import { createBuiltinToolRegistry } from "../tools/registry-factory.js";
import { cancelRun, decideRunDecision, decisionSummary, resolveDecisionTarget } from "../workflows/control.js";
import { listPendingDecisions } from "../workflows/decisions.js";
import { loadDefinition, WORKFLOW_TOOLS } from "../workflows/definition.js";
import { resolveWorkflow } from "../workflows/discovery.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import type { JobCoordinatorLike } from "../workflows/job-node.js";
import { launchRun, type RunnerCoordinator } from "../workflows/launch.js";
import { consentEnvNames, promptWorkflowConsent } from "../workflows/consent-prompt.js";
import {
  assertBackgroundRunsAvailable, cancelJobDeps, cliEntryPath, inboxLines, isTerminalRunStatus, launchSummary, listRuns,
  parseDecisionArgs, prepareLaunch, reconcileQuietly, startBackgroundRun, type StartRunDeps,
} from "../workflows/background.js";
import { formatRunSummary, formatRunTree, resolveRunId, statusGlyph } from "../workflows/format.js";
import type { ToolRegistry } from "../tools/registry.js";
import { applySandboxRequiredPolicy } from "../utils/sandbox-startup.js";
import { detectSandboxBackend, isSandboxRequired, setSandboxRequired } from "../utils/sandbox.js";
import { getSharedCoordinator } from "../background-jobs-integration.js";

const USAGE = `Usage
  agav workflows validate <name|file>
  agav workflows run <name|file> [--input '{"key":"value"}'] [--wait] [--json]
  agav workflows list [--json]
  agav workflows status <run-id> [--json]

<run-id> is the full UUID or any unique prefix of at least 4 characters (list shows 8).
--json prints the machine-readable form (status: full checkpoint; list/inbox: arrays).
  agav workflows inbox [<run-id>] [--json]
  agav workflows approve|deny <run-id> <node-id|decision-id> [--note <text>]
  agav workflows resume|cancel <run-id>

Runs execute in the background as supervised jobs and outlive this terminal. Every run asks
for consent (capabilities and which environment variable names reach the runner), so run
needs an interactive terminal. --wait follows the run until it finishes or needs approval;
Ctrl+C detaches without cancelling. A run that needs a decision (approval, tool consent, an
interrupted tool) parks and shows up in inbox; deciding it from any session resumes the run.
A bare name is looked up in ./.agav/workflows then ~/.agav/workflows (*.json, *.yaml, *.yml).
Enable both backgroundJobsEnabled and workflowsEnabled in ~/.agav/config.json. Approval nodes
do not grant tool permissions.
`;
const COMMANDS = ["validate", "run", "list", "status", "inbox", "approve", "deny", "resume", "cancel"];
type Coordinator = RunnerCoordinator & JobCoordinatorLike;

export interface WorkflowCliOptions {
  config?: AgavConfig;
  store?: WorkflowStore;
  getCoordinator?: () => Promise<Coordinator>;
  cliPath?: string;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  /** `--wait` poll interval (default 1000 ms). */
  pollIntervalMs?: number;
}

function parseRunArgs(rest: string[]): { inputs: Record<string, unknown>; wait: boolean; json: boolean } {
  let inputs: unknown = {}, wait = false, json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--wait") wait = true;
    else if (arg === "--json") json = true;
    else if ((arg === "--input" || arg === "--input-json") && i + 1 < rest.length) inputs = JSON.parse(rest[++i]!);
    else throw new Error(`Unexpected argument for workflows run: ${arg}`);
  }
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("--input must be a JSON object.");
  return { inputs: inputs as Record<string, unknown>, wait, json };
}

export async function runWorkflowsCli(argv: string[], options: WorkflowCliOptions = {}): Promise<number> {
  const [command, ...args] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) { process.stdout.write(USAGE); return 0; }
  const out = options.stdout ?? process.stdout;
  const write = (text: string): void => { out.write(text); };
  const warn = (text: string): void => { process.stderr.write(`warning: ${text}\n`); };
  try {
    const config = options.config ?? await loadConfig();
    if (config.backgroundJobsEnabled !== true || config.workflowsEnabled !== true) throw new Error("Workflows require backgroundJobsEnabled=true AND workflowsEnabled=true.");
    if (!COMMANDS.includes(command)) throw new Error(`Unsupported workflow command: ${command}`);
    const json = args.includes("--json") && ["list", "status", "run", "inbox"].includes(command);
    const [operand, ...rest] = command === "run" ? args : args.filter(arg => !(json && arg === "--json"));
    let target = operand;
    if (command === "list" ? target !== undefined : command !== "inbox" && !target) throw new Error(command === "list" ? `Unexpected argument for workflows list: ${target}` : `Missing operand.\n${USAGE}`);
    const isDecision = command === "approve" || command === "deny";
    if (command !== "run" && !isDecision && rest.length !== 0) throw new Error(`Unexpected or missing argument for workflows ${command}.`);
    if (isDecision && rest.length === 0) throw new Error(`Missing node or decision id for workflows ${command}.`);
    const registry = createBuiltinToolRegistry(WORKFLOW_TOOLS);
    const store = options.store ?? new WorkflowStore();
    const getCoordinator = options.getCoordinator ?? getSharedCoordinator;
    // Effective requirement of THIS invocation (config, which `--sandbox-required` sets, or an already-set process policy); it goes to every launch, never from a later global read.
    const sandboxRequired = config.sandboxRequired === true || isSandboxRequired();
    const launchDeps = async () => ({ coordinator: await getCoordinator(), cliPath: options.cliPath ?? await cliEntryPath(), maxConcurrentWorkflowRuns: config.maxConcurrentWorkflowRuns, registry, sandboxRequired });
    // Every run-id operand accepts a unique prefix (≥4 chars) or the full UUID (U4).
    if (target !== undefined && command !== "validate" && command !== "run") target = await resolveRunId(store, target);

    if (command === "validate") { await loadDefinition((await resolveWorkflow(target!, process.cwd())).path, registry); write("Workflow valid.\n"); return 0; }
    if (command === "list" || command === "status") {
      await reconcileQuietly(store, command === "status" ? target : undefined, await launchDeps(), warn);
      if (command === "status") {
        const run = await store.read(target!, registry);
        write((json ? JSON.stringify(run, null, 2) : formatRunTree(run)) + "\n");
        return 0;
      }
      const runs = await listRuns(store, registry);
      write(json ? JSON.stringify(runs.map(({ id, status, createdAt, updatedAt, definition }) => ({ id, status, workflow: definition.name, createdAt, updatedAt })), null, 2) + "\n" : runs.length ? runs.map(run => formatRunSummary(run)).join("\n") + "\n" : "No workflow runs.\n");
      return 0;
    }
    if (command === "inbox") {
      if (json) { write(JSON.stringify(await listPendingDecisions(store, target), null, 2) + "\n"); return 0; }
      const lines = await inboxLines(store, target);
      write(lines.length ? lines.join("\n") + "\n" : "No pending workflow decisions.\n");
      return 0;
    }
    if (isDecision) {
      // Writes only the create-once decision file; a parked run's runner is relaunched (attempt+1).
      const { note } = parseDecisionArgs(rest.slice(1));
      const pending = await resolveDecisionTarget(store, target!, rest[0]!);
      const result = await decideRunDecision(store, target!, pending.decisionId, command === "approve", { registry, note, launch: await launchDeps() });
      write(decisionSummary(result) + "\n");
      return result.won ? 0 : 1;
    }
    applySandboxRequiredPolicy({ flagSet: sandboxRequired, configValue: config.sandboxRequired, detectBackend: detectSandboxBackend, setRequired: setSandboxRequired, warn: message => { process.stderr.write(message); } });
    if (command === "cancel") {
      // The run's own consent covers stopping its runner and job nodes; without it nothing is pre-approved.
      const run = await cancelRun(store, target!, registry, undefined, cancelJobDeps(await store.read(target!, registry), getCoordinator, sandboxRequired, config.permissionMode));
      write(`Workflow run ${run.id}: ${run.status}\n`);
      return 0;
    }
    if (command === "resume") {
      // Background only: relaunch the run's runner (a new attempt) under the consent it was created with.
      const result = await launchRun(store, target!, await launchDeps());
      write(launchSummary(result) + "\n");
      return 0;
    }

    // run
    const { inputs, wait, json: asJson } = parseRunArgs(rest);
    // Consent is per invocation and never inferred: without a terminal there is no one to ask.
    const input = options.stdin ?? process.stdin;
    if (input.isTTY !== true || out.isTTY !== true) throw new Error("workflow run requires interactive consent");
    const resolved = await resolveWorkflow(target!, process.cwd());
    // Validated before consent; the run is only created once the user approves.
    const prepared = await prepareLaunch(await loadDefinition(resolved.path, registry), inputs, resolved.name, config, consentEnvNames(options.env));
    const deps = await launchDeps();
    await assertBackgroundRunsAvailable(deps.coordinator);
    const envNames = await promptWorkflowConsent(prepared.request, input, out);
    if (!envNames) { write("Workflow run not approved.\n"); return 1; }
    const result = await startBackgroundRun(store, prepared, config.permissionMode, envNames, deps);
    write(asJson ? JSON.stringify({ status: result.status, run: result.run }, null, 2) + "\n" : launchSummary(result) + "\n");
    if (!wait) return 0;
    return await waitForRun(store, result.run, deps, options.pollIntervalMs ?? 1000, write, warn);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Follows a run until it is terminal, needs approval, or stays interrupted, printing each status change.
 * Ctrl+C only detaches: the run keeps going in the background.
 */
async function waitForRun(store: WorkflowStore, initial: WorkflowRun, deps: StartRunDeps & { registry: ToolRegistry }, intervalMs: number, write: (text: string) => void, warn: (text: string) => void): Promise<number> {
  let detached = false;
  let wake: (() => void) | undefined;
  const detach = (): void => { detached = true; wake?.(); };
  process.on("SIGINT", detach);
  let last = initial.status;
  const statuses = new Map(initial.nodes.map(cp => [cp.id, cp.status]));
  try {
    for (;;) {
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, intervalMs); wake = () => { clearTimeout(timer); resolve(); }; });
      if (detached) { write(`Detached; workflow run ${initial.id} continues in the background.\n`); return 0; }
      await reconcileQuietly(store, initial.id, deps, warn);
      const run = await store.read(initial.id, deps.registry);
      for (const cp of run.nodes) if (statuses.get(cp.id) !== cp.status) { statuses.set(cp.id, cp.status); write(`  ${statusGlyph(cp.status)} ${cp.id}: ${cp.status}${cp.error ? ` — ${cp.error}` : ""}\n`); }
      if (run.status !== last) { last = run.status; write(`${formatRunSummary(run)}\n`); }
      if (isTerminalRunStatus(run.status)) { write(formatRunTree(run) + "\n"); return run.status === "passed" ? 0 : 1; }
      if (run.status === "waiting_approval") { write(`Waiting for approval: agav workflows inbox ${run.id}, then agav workflows approve ${run.id} <node-id|decision-id>\n`); return 0; }
      if (run.status === "interrupted") { write(`Run is interrupted and was not relaunched: agav workflows status ${run.id}\n`); return 1; }
    }
  } finally {
    process.removeListener("SIGINT", detach);
  }
}
