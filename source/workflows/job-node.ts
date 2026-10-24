/**
 * Adapter that runs a workflow `job` node on the background-jobs coordinator.
 *
 * Safety rules:
 *  - The coordinator is unsandboxed, so a fresh start is refused when `sandboxRequired` is set.
 *  - A node is started at most once per run (`wf-<runId>-<nodeId>-1`); resume only reattaches.
 *  - `coordinator.wait` is deliberately not used (it spins on uncertain states and aborting it does
 *    not stop the job); observation is a cancellation-aware poll loop.
 *  - unknown / recovery-required (or any unrecognised state) is uncertain and fails closed.
 *  - A log retrieval error never re-runs the job; terminal identity is kept in the metadata.
 */
import { platform as osPlatform } from "node:os";
import { isHeadlessActionApproved } from "../background-jobs/authorization/policy.js";
import {
  isLiveLifecycle,
  isTerminalLifecycle,
  isUncertainLifecycle,
  type CoordinatorClient,
  type JobSummary,
  type SessionPolicySnapshot,
  type ShellInterpreter,
  type StartJobRequest,
} from "../background-jobs/types.js";
import { isPersistableJobState, type JobNodeMetadata, type NodeCheckpoint } from "./store.js";

export type JobCoordinatorLike = Pick<CoordinatorClient, "start" | "poll" | "log" | "stop" | "findByRequestId">;

/** Trusted application dependencies; never read from workflow definitions. */
export interface JobNodeDeps {
  getCoordinator(): Promise<JobCoordinatorLike>;
  /** Session policy handed to `coordinator.start`; headless callers must not pre-approve actions. */
  session: SessionPolicySnapshot | (() => SessionPolicySnapshot);
  /** The coordinator runs unsandboxed: fresh starts are refused when true. */
  sandboxRequired: boolean;
  /**
   * Host-supplied headless flag forwarded to the coordinator's authorization. Required so a caller can never
   * implicitly run interactive; a non-boolean value reaching runtime (untyped caller) is treated as headless.
   */
  headless: boolean;
  /** Poll interval in ms (default 250). */
  pollIntervalMs?: number;
  /** Per-call deadline for coordinator lookups/polls/log reads and `getCoordinator` (default 30000). */
  callDeadlineMs?: number;
  /** Deadline for the coordinator `stop` call itself, including interactive approval (default 120000). */
  stopDeadlineMs?: number;
  /** How long to poll for a terminal state after a stop request (default 15000). */
  stopSettleMs?: number;
}

export interface JobNodeOutcome {
  /** "incomplete": cancellation could not be confirmed; the job may still be live and the node stays running. */
  status: "passed" | "failed" | "cancelled" | "incomplete";
  output?: string;
  error?: string;
  job: JobNodeMetadata;
}

export const STDOUT_TAIL_BYTES = 65536;
export const STDERR_TAIL_BYTES = 8192;
const MAX_POLL_FAILURES = 3;

function defaultShellInterpreter(): ShellInterpreter { return osPlatform() === "win32" ? "cmd" : "posix-sh"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Returns a refusal reason when a fresh job may not be started under this configuration. */
export function jobStartRefusal(deps: JobNodeDeps): string | undefined {
  return deps.sandboxRequired
    ? "Job nodes are refused while sandboxRequired is enabled: background jobs run outside the OS sandbox."
    : undefined;
}

export const DEFAULT_CALL_DEADLINE_MS = 30_000;
function callDeadline(deps: JobNodeDeps): number { return deps.callDeadlineMs ?? DEFAULT_CALL_DEADLINE_MS; }

/**
 * Rejects if `promise` does not settle within `ms`. The timer is always cleared and a late result or
 * rejection is swallowed (both handlers are attached), so a wedged call can neither hang the caller
 * nor produce an unhandled rejection. The underlying call itself cannot be cancelled.
 */
export function withDeadline<T>(promise: PromiseLike<T> | T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not respond within ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

const ABORTED = Symbol("aborted");
/** Resolves ABORTED as soon as `signal` aborts; the pending promise's late outcome is ignored. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => { resolve(ABORTED); };
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type Admission = { ok: true; summary: JobSummary } | { ok: false; error: string };

export interface JobNodeStartInput {
  requestId: string;
  command: string;
  /** The original run cwd. */
  cwd: string;
  /** Stored job id from a running checkpoint, if any. */
  jobId?: string;
  /** True when a running checkpoint is being resumed: never start, only reattach. */
  resume: boolean;
  signal: AbortSignal;
}

/** Start a new job (fresh) or find the existing one (resume). Never starts when resuming. */
export async function startOrReattachJobNode(deps: JobNodeDeps, input: JobNodeStartInput): Promise<Admission> {
  const deadlineMs = callDeadline(deps);
  const coordinator = await withDeadline(deps.getCoordinator(), deadlineMs, "background-job coordinator");
  if (input.resume) return reattach(coordinator, input, deadlineMs);
  const refusal = jobStartRefusal(deps);
  if (refusal) return { ok: false, error: refusal };
  const base = typeof deps.session === "function" ? deps.session() : deps.session;
  const session: SessionPolicySnapshot = base.signal ? base : { ...base, signal: input.signal };
  const request: StartJobRequest = {
    requestId: input.requestId,
    invocation: { mode: "shell", interpreter: defaultShellInterpreter(), commandText: input.command },
    cwd: input.cwd,
    isolation: { backend: "none", required: false },
    // Fails closed: anything but an explicit `false` (e.g. an untyped caller omitting it) is headless.
    headless: deps.headless !== false,
  };
  try {
    return { ok: true, summary: await coordinator.start(request, session) };
  } catch (startError) {
    // The coordinator may have admitted the job before throwing: look before declaring failure.
    let found: JobSummary | undefined;
    let lookupError: unknown;
    try { found = await withDeadline(coordinator.findByRequestId?.(input.requestId), deadlineMs, "lookup by requestId"); } catch (error) { lookupError = error; }
    if (found && found.requestId === input.requestId) return { ok: true, summary: found };
    if (lookupError !== undefined) return { ok: false, error: `uncertain: start failed (${message(startError)}) and lookup by requestId failed (${message(lookupError)}); job ${input.requestId} may exist.` };
    if (!coordinator.findByRequestId) return { ok: false, error: `uncertain: start failed (${message(startError)}) and the coordinator cannot look up requestId ${input.requestId}.` };
    return { ok: false, error: `Job start failed: ${message(startError)} (no job found for ${input.requestId}).` };
  }
}

async function reattach(coordinator: JobCoordinatorLike, input: JobNodeStartInput, deadlineMs: number): Promise<Admission> {
  let pollError: unknown;
  if (input.jobId) {
    try {
      const summary = await withDeadline(coordinator.poll(input.jobId), deadlineMs, `poll of job ${input.jobId}`);
      if (summary.requestId !== input.requestId) return { ok: false, error: `uncertain: job ${input.jobId} does not belong to ${input.requestId}; refusing to start a second workload.` };
      return { ok: true, summary };
    } catch (error) { pollError = error; }
  }
  let found: JobSummary | undefined;
  let lookupError: unknown;
  try { found = await withDeadline(coordinator.findByRequestId?.(input.requestId), deadlineMs, "lookup by requestId"); } catch (error) { lookupError = error; }
  if (found && found.requestId === input.requestId) return { ok: true, summary: found };
  const detail = [pollError !== undefined ? `poll: ${message(pollError)}` : "", lookupError !== undefined ? `lookup: ${message(lookupError)}` : "", !coordinator.findByRequestId ? "lookup unsupported" : ""].filter(Boolean).join("; ");
  return { ok: false, error: `uncertain: cannot verify job for ${input.requestId}${detail ? ` (${detail})` : ""}; refusing to start a second workload.` };
}

async function readLog(coordinator: JobCoordinatorLike, jobId: string, stream: "stdout" | "stderr", maxBytes: number, deadlineMs: number): Promise<{ text: string; truncated: boolean } | { error: string }> {
  try {
    const tail = await withDeadline(coordinator.log(jobId, { stream, maxBytes }), deadlineMs, `log read of job ${jobId}`);
    return { text: tail.text, truncated: tail.truncated };
  } catch (error) { return { error: message(error) }; }
}

/** Cancellation-aware observation of an admitted job until it is terminal or uncertain. */
export async function observeJobNode(deps: JobNodeDeps, initial: JobSummary, requestId: string, signal: AbortSignal): Promise<JobNodeOutcome> {
  const deadlineMs = callDeadline(deps);
  const coordinator = await withDeadline(deps.getCoordinator(), deadlineMs, "background-job coordinator");
  const interval = deps.pollIntervalMs ?? 250;
  const jobId = initial.jobId;
  const meta = (summary: JobSummary): JobNodeMetadata => jobMeta(summary, requestId);
  let current = initial;
  let failures = 0;
  for (;;) {
    const state = current.state;
    if (current.requestId !== requestId) return { status: "failed", error: `uncertain: job ${jobId} does not belong to ${requestId}.`, job: { requestId, jobId } };
    if (isTerminalLifecycle(state)) return finalize(coordinator, current, meta(current), deadlineMs);
    if (isUncertainLifecycle(state) || !["accepted", "starting", "running"].includes(state)) {
      return { status: "failed", error: `uncertain: job ${jobId} is in state "${state}"; outcome unknown, not retried.`, job: meta(current) };
    }
    if (signal.aborted) return stopJobNodeOutcome(deps, { requestId, jobId });
    await sleep(interval, signal);
    if (signal.aborted) continue;
    try {
      // Race the (deadline-bounded) poll against the abort signal so Ctrl+C reaches the stop path promptly.
      const polled = await raceAbort(withDeadline(coordinator.poll(jobId), deadlineMs, `poll of job ${jobId}`), signal);
      if (polled === ABORTED) continue;
      current = polled; failures = 0;
    } catch (error) {
      if (++failures >= MAX_POLL_FAILURES) return { status: "failed", error: `uncertain: polling job ${jobId} failed ${failures} times (${message(error)}); outcome unknown, not retried.`, job: meta(current) };
    }
  }
}

/** Only a state `store.read` accepts may be persisted; an unrecognised one would make the whole run unreadable. */
function persistableState(state: unknown): { state?: string } { return isPersistableJobState(state) ? { state } : {}; }

function jobMeta(summary: JobSummary, requestId: string): JobNodeMetadata {
  return { requestId, jobId: summary.jobId, ...persistableState(summary.state), ...(summary.exitCode === undefined ? {} : { exitCode: summary.exitCode }) };
}

/** Identity of a job node's job: the deterministic requestId and, once persisted, the jobId. */
export interface JobRef { requestId: string; jobId?: string }

export type StopJobResult =
  | { kind: "terminal"; summary: JobSummary }
  /** A successful requestId lookup found nothing and no jobId was stored: the job was never launched. */
  | { kind: "never-started"; job: JobNodeMetadata }
  | { kind: "incomplete"; reason: string; job: JobNodeMetadata };

export const DEFAULT_STOP_DEADLINE_MS = 120_000;
export const DEFAULT_STOP_SETTLE_MS = 15_000;

/**
 * Stops the job behind a node and reports only what was observed.
 * `terminal` carries the job's real final summary (interrupted, or completed/failed if it finished first).
 * `incomplete` is returned whenever termination is not confirmed (lookup failed, stop denied or threw,
 * state still live/uncertain after the bounded wait); the job must then be treated as possibly running.
 * The stop uses a fresh, non-aborted signal: the run's own (aborted) signal would make authorization deny immediately.
 */
export async function stopJobNode(deps: JobNodeDeps, ref: JobRef): Promise<StopJobResult> {
  const known: JobNodeMetadata = { requestId: ref.requestId, ...(ref.jobId ? { jobId: ref.jobId } : {}) };
  const incomplete = (reason: string, job: JobNodeMetadata = known): StopJobResult => ({ kind: "incomplete", reason, job });
  const callMs = callDeadline(deps);
  let coordinator: JobCoordinatorLike;
  try { coordinator = await withDeadline(deps.getCoordinator(), callMs, "background-job coordinator"); }
  catch (error) { return incomplete(`background-job coordinator unavailable (${message(error)}); the job was not stopped`); }

  const resolved = await resolveJob(coordinator, ref, callMs);
  if ("neverStarted" in resolved) return { kind: "never-started", job: known };
  if ("error" in resolved) return incomplete(resolved.error);
  let summary = resolved.summary;
  let job = jobMeta(summary, ref.requestId);
  const jobId = summary.jobId;
  if (isTerminalLifecycle(summary.state)) return { kind: "terminal", summary };
  if (!isLiveLifecycle(summary.state)) return incomplete(`job ${jobId} is in state "${summary.state}"; its outcome is uncertain and it cannot be stopped safely`, job);

  let base: SessionPolicySnapshot;
  try {
    base = typeof deps.session === "function" ? deps.session() : deps.session;
    // The coordinator applies the headless gate to `start` only; enforce it for `stop` here.
    // Anything but an explicit `false` is treated as headless (fail closed). A malformed session throws into the catch.
    if (deps.headless !== false && !isHeadlessActionApproved("stop", base)) {
      return incomplete(`job ${jobId} is still ${summary.state} and was not stopped: headless execution requires an explicit applicable grant for "stop"; none is present`, job);
    }
  } catch (error) { return incomplete(`session policy unavailable (${message(error)}); job ${jobId} is still ${summary.state} and was not stopped`, job); }

  const controller = new AbortController();
  const deadlineMs = deps.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">(resolve => { deadlineTimer = setTimeout(() => { controller.abort(); resolve("deadline"); }, deadlineMs); });
  let stopFailure: string | undefined;
  try {
    const result = await Promise.race([coordinator.stop(jobId, { ...base, signal: controller.signal }), deadline]);
    if (result === "deadline") stopFailure = `stop request did not complete within ${deadlineMs}ms`;
    else if (result.requestId !== ref.requestId) return incomplete(`stop for job ${jobId} returned a job that does not belong to ${ref.requestId}`, known);
    else { summary = result; job = jobMeta(summary, ref.requestId); }
  } catch (error) {
    stopFailure = `stop request failed (${message(error)})`;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
  if (stopFailure === undefined && isTerminalLifecycle(summary.state)) return { kind: "terminal", summary };

  // Bounded wait for a terminal state. The job may have finished on its own even if the stop call failed.
  const settleMs = deps.stopSettleMs ?? DEFAULT_STOP_SETTLE_MS;
  const interval = deps.pollIntervalMs ?? 250;
  const never = new AbortController().signal;
  const until = Date.now() + settleMs;
  let pollFailure: string | undefined;
  for (;;) {
    try {
      const polled = await withDeadline(coordinator.poll(jobId), callMs, `poll of job ${jobId}`);
      if (polled.requestId !== ref.requestId) return incomplete(`polled job ${jobId} does not belong to ${ref.requestId}`, known);
      summary = polled; job = jobMeta(summary, ref.requestId); pollFailure = undefined;
      if (isTerminalLifecycle(summary.state)) return { kind: "terminal", summary };
    } catch (error) { pollFailure = message(error); }
    // After a failed stop one confirming poll is enough; do not keep waiting for a stop that was not accepted.
    if (stopFailure !== undefined || Date.now() >= until) break;
    await sleep(Math.min(interval, Math.max(0, until - Date.now())), never);
  }
  const state = pollFailure !== undefined ? `unverified (poll failed: ${pollFailure})` : `still "${summary.state}"`;
  return incomplete(stopFailure !== undefined ? `${stopFailure}; job ${jobId} is ${state}` : `job ${jobId} is ${state} ${settleMs}ms after the stop request`, job);
}

async function resolveJob(coordinator: JobCoordinatorLike, ref: JobRef, callMs: number): Promise<{ summary: JobSummary } | { neverStarted: true } | { error: string }> {
  let pollError: unknown;
  if (ref.jobId) {
    try {
      const summary = await withDeadline(coordinator.poll(ref.jobId), callMs, `poll of job ${ref.jobId}`);
      if (summary.requestId === ref.requestId) return { summary };
      return { error: `job ${ref.jobId} does not belong to ${ref.requestId}; not stopping a different workload` };
    } catch (error) { pollError = error; }
  }
  let lookupError: unknown;
  try {
    const found = await withDeadline(coordinator.findByRequestId?.(ref.requestId), callMs, "lookup by requestId");
    if (found && found.requestId === ref.requestId) return { summary: found };
  } catch (error) { lookupError = error; }
  // A successful lookup that found nothing, with no stored jobId, proves nothing was ever launched
  // (e.g. a crash between the durable running checkpoint and `start`). Any error, missing lookup support
  // or a stored jobId keeps this uncertain.
  if (coordinator.findByRequestId && lookupError === undefined && !ref.jobId) return { neverStarted: true };
  const detail = [
    pollError !== undefined ? `poll: ${message(pollError)}` : "",
    lookupError !== undefined ? `lookup: ${message(lookupError)}` : "",
    !coordinator.findByRequestId ? "lookup unsupported" : "",
    coordinator.findByRequestId && lookupError === undefined ? "no job found for the requestId" : "",
  ].filter(Boolean).join("; ");
  return { error: `cannot verify job for ${ref.requestId} (${detail}); the job was not stopped` };
}

/** Stops a job node's job and maps the result to a node outcome (terminal -> real outcome; else incomplete). */
export async function stopJobNodeOutcome(deps: JobNodeDeps, ref: JobRef): Promise<JobNodeOutcome> {
  const stopped = await stopJobNode(deps, ref);
  if (stopped.kind === "incomplete") return { status: "incomplete", error: `cancellation incomplete: ${stopped.reason}`, job: stopped.job };
  if (stopped.kind === "never-started") return { status: "cancelled", error: "Job never started: no job exists for this node's requestId; nothing to stop.", job: stopped.job };
  const job = jobMeta(stopped.summary, ref.requestId);
  const callMs = callDeadline(deps);
  try { return await finalize(await withDeadline(deps.getCoordinator(), callMs, "background-job coordinator"), stopped.summary, job, callMs); }
  catch (error) { return { status: "incomplete", error: `cancellation incomplete: job ${stopped.summary.jobId} stopped but its result could not be read (${message(error)}); resume or cancel again to finalize`, job }; }
}

/** Records an outcome on a checkpoint; `incomplete` keeps the node running with its job linkage. */
export function applyJobOutcome(cp: NodeCheckpoint, outcome: JobNodeOutcome): void {
  cp.job = { ...cp.job, ...outcome.job };
  if (outcome.output !== undefined) cp.output = outcome.output;
  if (outcome.error !== undefined) cp.error = outcome.error; else delete cp.error;
  if (outcome.status === "incomplete") { cp.status = "running"; delete cp.endedAt; return; }
  cp.status = outcome.status;
  cp.endedAt = new Date().toISOString();
}

/** Raised when cancellation of a run could not be confirmed; the run is left non-terminal so it can be retried or resumed. */
export class JobCancellationIncompleteError extends Error {
  constructor(readonly nodeId: string, readonly reason: string) {
    super(`cancellation incomplete: ${reason.replace(/^cancellation incomplete: /, "")} (node ${nodeId}; the run was left non-terminal and its job linkage is kept so resume or cancel can retry)`);
    this.name = "JobCancellationIncompleteError";
  }
}

async function finalize(coordinator: JobCoordinatorLike, summary: JobSummary, job: JobNodeMetadata, deadlineMs: number): Promise<JobNodeOutcome> {
  const jobId = summary.jobId;
  if (summary.state === "interrupted") return { status: "cancelled", error: `Job ${jobId} was interrupted.`, job };
  if (summary.state === "failed" || (summary.state === "completed" && summary.exitCode !== 0)) {
    const stderr = await readLog(coordinator, jobId, "stderr", STDERR_TAIL_BYTES, deadlineMs);
    const tail = "error" in stderr ? ` (stderr unavailable: ${stderr.error})` : stderr.text ? `\n${stderr.text}` : "";
    return { status: "failed", error: `Job ${jobId} ${summary.state}${summary.exitCode === undefined || summary.exitCode === null ? "" : ` with exit code ${summary.exitCode}`}${tail}`, job };
  }
  const stdout = await readLog(coordinator, jobId, "stdout", STDOUT_TAIL_BYTES, deadlineMs);
  // The job itself finished: keep its terminal identity and never re-run it.
  if ("error" in stdout) return { status: "failed", error: `Output error: job ${jobId} completed (exit 0) but stdout could not be read: ${stdout.error}`, job };
  return { status: "passed", output: stdout.text, job: { ...job, outputTruncated: stdout.truncated } };
}

export interface JobNodeRunInput extends JobNodeStartInput {
  /** Persist durable evidence (requestId/jobId) right after admission, before observing. */
  onAdmitted(job: JobNodeMetadata): Promise<void>;
}

/** Start-or-reattach then observe. Only `onAdmitted` persistence errors are thrown. */
export async function runJobNode(deps: JobNodeDeps, input: JobNodeRunInput): Promise<JobNodeOutcome> {
  const base: JobNodeMetadata = { requestId: input.requestId, ...(input.jobId ? { jobId: input.jobId } : {}) };
  // Never launch new work once cancellation is requested; a resumed job is still reattached below.
  if (!input.resume && input.signal.aborted) return { status: "cancelled", error: "Workflow cancelled before the job was started.", job: base };
  const admission = await startOrReattachJobNode(deps, input);
  if (!admission.ok) return { status: "failed", error: admission.error, job: base };
  const { summary } = admission;
  await input.onAdmitted({ requestId: input.requestId, jobId: summary.jobId, ...persistableState(summary.state) });
  return observeJobNode(deps, summary, input.requestId, input.signal);
}
