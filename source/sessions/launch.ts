import { getNodeEntryLoaderArgs, getSessionRunnerArgs, isStandaloneBinary } from "../background-jobs/packaging/manifest.js";
import { isTerminalLifecycle, type CoordinatorClient, type JobSummary, type SessionPolicySnapshot, type StartJobRequest } from "../background-jobs/types.js";
import { assertSessionRuntimeId, type SessionRuntimeRecord, type SessionRuntimeStore } from "./store.js";

export interface SessionWorkerLaunchDeps {
  store: SessionRuntimeStore;
  coordinator: Pick<CoordinatorClient, "start" | "findByRequestId">;
  cliPath: string;
  /** Selected environment names only; their values never enter launch metadata. */
  envNames: string[];
  /** Caller-authorized launch policy, separate from the worker's tool policies. No auto-accept default. */
  session: SessionPolicySnapshot;
}

export interface SessionWorkerLaunchResult {
  status: "started" | "attached";
  record: SessionRuntimeRecord;
  job: JobSummary;
}

/** Length-prefix the id so two valid id/generation pairs cannot alias. */
export function sessionWorkerRequestId(record: Pick<SessionRuntimeRecord, "id" | "generation">): string {
  assertSessionRuntimeId(record.id);
  assertSessionRuntimeId(record.generation);
  return `session-run-${record.id.length}-${record.id}-${record.generation}`;
}

/** The worker enforces tool sandbox requirements; the supervisor only owns its lifetime. */
export function sessionWorkerStartRequest(record: SessionRuntimeRecord, cliPath: string, envNames: readonly string[], standalone = isStandaloneBinary()): StartJobRequest {
  return {
    requestId: sessionWorkerRequestId(record),
    invocation: { mode: "direct", executable: process.execPath, args: getSessionRunnerArgs(record.id, standalone ? undefined : cliPath, standalone ? [] : getNodeEntryLoaderArgs(cliPath), record.generation) },
    cwd: record.cwd,
    envInherit: [...new Set([...envNames, ...(process.env.AGAV_HOME !== undefined ? ["AGAV_HOME"] : [])])],
    isolation: { backend: "none", required: false },
    headless: true,
  };
}

/**
 * Launch exactly this persisted execution generation. Existing jobs (including finished jobs) are
 * reattached, never replayed. An uncertain launch retains its generation and durable starting intent;
 * coordinator request-id deduplication, not a new generation, resolves a later explicit retry.
 */
export async function launchSessionWorker(record: SessionRuntimeRecord, deps: SessionWorkerLaunchDeps): Promise<SessionWorkerLaunchResult> {
  if (!deps.session) throw new Error("Session worker launch requires a caller policy snapshot.");
  const find = deps.coordinator.findByRequestId;
  if (!find) throw new Error("The background-job coordinator cannot look up session workers by requestId.");
  const current = await deps.store.read(record.id);
  if (!current || current.generation !== record.generation) throw new Error(`Missing or stale session runtime generation: ${record.id}`);
  const requestId = sessionWorkerRequestId(current);
  const lookup = async (): Promise<JobSummary | undefined> => {
    const found = await find.call(deps.coordinator, requestId);
    if (found && found.requestId !== requestId) throw new Error("Session worker request identity mismatch.");
    return found;
  };
  const persistJob = async (job: JobSummary): Promise<SessionRuntimeRecord> => {
    if (job.requestId !== requestId) throw new Error("Session worker request identity mismatch.");
    // Preserve status/approval changes made by a fast-starting worker, and fence stale generations.
    await deps.store.update(current.id, current.generation, latest => {
      latest.jobId = job.jobId;
      // A crashed/killed owner cannot consume approvals or continue JavaScript promises.
      // Never present a dead execution as approval-ready and never replay uncertain tools.
      if (isTerminalLifecycle(job.state) && ["starting", "running", "needs-approval"].includes(latest.status)) {
        latest.status = "interrupted";
        latest.error = `Session worker ended (${job.state}) before recording completion.`;
      }
    });
    const saved = await deps.store.read(current.id);
    if (!saved || saved.generation !== current.generation) throw new Error(`Stale session runtime generation: ${current.id}`);
    return saved;
  };
  const existing = await lookup();
  if (existing) return { status: "attached", record: await persistJob(existing), job: existing };
  if (current.jobId || current.status !== "starting") {
    throw new Error(`Session ${current.id} has no recoverable worker; refusing to replay this execution.`);
  }
  const request = sessionWorkerStartRequest(current, deps.cliPath, deps.envNames);
  const missing = request.envInherit!.filter(name => process.env[name] === undefined);
  if (missing.length) throw new Error(`Session worker was not launched: missing selected environment variable(s): ${missing.join(", ")}`);
  // Persist intent before crossing the launch boundary. Generation itself is the durable request identity.
  await deps.store.update(current.id, current.generation, latest => {
    if (latest.jobId || latest.status !== "starting") throw new Error(`Session ${latest.id} changed ownership during launch; refusing to replay this execution.`);
  });
  let job: JobSummary;
  try {
    job = await deps.coordinator.start(request, deps.session);
  } catch (error) {
    // Admission may have succeeded before the response was lost. Never invent another identity.
    const found = await lookup().catch(() => undefined);
    if (!found) throw error;
    job = found;
  }
  return { status: "started", record: await persistJob(job), job };
}
