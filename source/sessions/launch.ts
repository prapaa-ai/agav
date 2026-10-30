import { getNodeEntryLoaderArgs, getSessionRunnerArgs, isStandaloneBinary } from "../background-jobs/packaging/manifest.js";
import { BackgroundJobError, PreSpawnLaunchError, isTerminalLifecycle, type CoordinatorClient, type JobSummary, type SessionPolicySnapshot, type StartJobRequest } from "../background-jobs/types.js";
import { assertSessionRuntimeId, type SessionRuntimeRecord, type SessionRuntimeStore } from "./store.js";

export interface SessionWorkerLaunchDeps {
  store: SessionRuntimeStore;
  coordinator: Pick<CoordinatorClient, "start" | "findByRequestId">;
  cliPath: string;
  /** Selected environment names only; their values never enter launch metadata. */
  envNames: string[];
  /** Caller-authorized launch policy, separate from the worker's tool policies. No auto-accept default. */
  session: SessionPolicySnapshot;
  /** Only the interactive host may request foreground consent for its internal owner. */
  interactiveOwner?: true;
}

export interface SessionWorkerLaunchResult {
  status: "started" | "attached";
  record: SessionRuntimeRecord;
  job: JobSummary;
}

/** The record is authoritative: only a confirmed terminal record releases UI ownership. */
export class SessionWorkerLaunchError extends Error {
  constructor(message: string, public readonly admission: "not-admitted" | "unknown", public readonly record: SessionRuntimeRecord, cause: unknown) {
    super(message, { cause });
    this.name = "SessionWorkerLaunchError";
  }
}

/** Use only when the caller knows it has not crossed the coordinator start boundary. */
export async function failSessionWorkerBeforeAdmission(store: SessionRuntimeStore, record: SessionRuntimeRecord, cause: unknown): Promise<SessionWorkerLaunchError> {
  const message = cause instanceof Error ? cause.message : String(cause);
  const saved = await store.update(record.id, record.generation, latest => {
    if (latest.status === "starting" && !latest.jobId && !latest.ownerPid) {
      latest.status = "failed";
      latest.error = message;
    }
  });
  return new SessionWorkerLaunchError(message, saved.status === "failed" ? "not-admitted" : "unknown", saved, cause);
}

const UNCERTAIN_ADMISSION = "Session worker admission is uncertain; ownership retained.";

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

/** Existing or uncertain executions are reconciled by identity, never replayed. */
export async function launchSessionWorker(record: SessionRuntimeRecord, deps: SessionWorkerLaunchDeps): Promise<SessionWorkerLaunchResult> {
  const current = await deps.store.read(record.id);
  if (!current || current.generation !== record.generation) throw new Error(`Missing or stale session runtime generation: ${record.id}`);
  let crossedAdmission = current.error === UNCERTAIN_ADMISSION || !!current.jobId || current.status !== "starting";
  const requestId = sessionWorkerRequestId(current);
  const lookup = async (): Promise<JobSummary | undefined> => {
    const found = await deps.coordinator.findByRequestId!.call(deps.coordinator, requestId);
    if (found && found.requestId !== requestId) throw new Error("Session worker request identity mismatch.");
    return found;
  };
  const persistJob = async (job: JobSummary): Promise<SessionRuntimeRecord> => {
    if (job.requestId !== requestId) throw new Error("Session worker request identity mismatch.");
    // Preserve status/approval changes made by a fast-starting worker, and fence stale generations.
    return deps.store.update(current.id, current.generation, latest => {
      latest.jobId = job.jobId;
      if (latest.error === UNCERTAIN_ADMISSION) delete latest.error;
      if (isTerminalLifecycle(job.state) && ["starting", "running", "needs-approval"].includes(latest.status)) {
        latest.status = "interrupted";
        latest.error = `Session worker ended (${job.state}) before recording completion.`;
      }
    });
  };
  try {
    if (!deps.session) throw new Error("Session worker launch requires a caller policy snapshot.");
    if (!deps.coordinator.findByRequestId) throw new Error("The background-job coordinator cannot look up session workers by requestId.");
    const existing = await lookup();
    if (existing) {
      crossedAdmission = true;
      return { status: "attached", record: await persistJob(existing), job: existing };
    }
    if (crossedAdmission) throw new Error(`Session ${current.id} has no recoverable worker; refusing to replay this execution.`);
    const request = sessionWorkerStartRequest(current, deps.cliPath, deps.envNames);
    if (deps.interactiveOwner) request.headless = false;
    const missing = request.envInherit!.filter(name => process.env[name] === undefined);
    if (missing.length) throw new Error(`Session worker was not launched: missing selected environment variable(s): ${missing.join(", ")}`);
    deps.session.signal?.throwIfAborted();
    // Persist an ownership barrier BEFORE start. A crash or an empty subsequent lookup is not
    // evidence of non-admission. A later call may attach a job, but may not start this intent again.
    await deps.store.update(current.id, current.generation, latest => {
      if (latest.jobId || latest.status !== "starting" || latest.error === UNCERTAIN_ADMISSION) {
        crossedAdmission = true;
        throw new Error(`Session ${latest.id} changed ownership during launch; refusing to replay this execution.`);
      }
      latest.error = UNCERTAIN_ADMISSION;
    });
    crossedAdmission = true;
    let job: JobSummary;
    try {
      job = await deps.coordinator.start(request, deps.session);
    } catch (error) {
      // Inspect the actual coordinator's pre-admission errors. Storage, lock, not-found and
      // generic transport errors can also occur AFTER admission and must remain uncertain.
      const found = await lookup().catch(() => undefined);
      if (found) job = found;
      else {
        if (error instanceof PreSpawnLaunchError || error instanceof BackgroundJobError &&
            ["authorization-denied", "capacity-exceeded", "isolation-unavailable", "unsupported-platform"].includes(error.code)) {
          throw await failSessionWorkerBeforeAdmission(deps.store, current, error);
        }
        throw error;
      }
    }
    return { status: "started", record: await persistJob(job), job };
  } catch (error) {
    if (error instanceof SessionWorkerLaunchError) throw error;
    if (!crossedAdmission) throw await failSessionWorkerBeforeAdmission(deps.store, current, error);
    const saved = await deps.store.read(current.id);
    if (!saved || saved.generation !== current.generation) throw error;
    throw new SessionWorkerLaunchError(error instanceof Error ? error.message : String(error), "unknown", saved, error);
  }
}
