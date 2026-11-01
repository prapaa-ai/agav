// poll/wait/stop use fresh liveness evidence from recovery/reconcile rather than stale on-disk state.
import { randomUUID } from "node:crypto";

import {
  BACKGROUND_JOBS_PROTOCOL_VERSION,
  BackgroundJobError,
  isLiveLifecycle,
  isTerminalLifecycle,
  PreSpawnLaunchError,
  type ConfirmSubject,
  type CoordinatorClient,
  type JobRecord,
  type JobSummary,
  type LaunchSpec,
  type LogTail,
  type PlatformCapabilities,
  type Repositories,
  type SessionPolicySnapshot,
  type StartJobRequest,
} from "../types.js";
import { checkStorageVersion, ensureStorageVersionFile, resolveStorageRoot } from "../storage/paths.js";
import { createFileRepositories } from "../storage/repositories.js";
import { withJobLock, withCoordinatorLock } from "../storage/single-writer-lock.js";
import { createAuthorizationService, type AuthorizationService } from "../authorization/service.js";
import { hashLaunchSpecForConsent, type ConsentRelevantSpec } from "../authorization/spec-hash.js";
import { normalizeLaunchSpec } from "../launch-spec/normalize.js";
import { getPlatformAdapter } from "../platform/index.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { IpcClient } from "../ipc/client.js";
import { reconcileJob } from "../recovery/reconcile.js";
import { createMailboxService, type MailboxService } from "../mailbox/mailbox-service.js";
import { readCursor, readTail, type LogStream } from "../logging/segment-reader.js";
import { reserveCapacity } from "./admission.js";
import { launchSupervisorForJob, socketNameForJob } from "./launcher.js";
import { join } from "node:path";
import { rm } from "node:fs/promises";

/** Extras beyond `CoordinatorClient`, not visible to callers holding only that type. */
export interface CoordinatorExtensions {
  /** Operator-only abandonment; does not stop or replay work. */
  abandonJob(jobId: string, acknowledgeUnverified: boolean, session: SessionPolicySnapshot): Promise<JobSummary>;
  mailbox: MailboxService;
  repositories: Repositories;
  authorization: AuthorizationService;
  root: string;
  findByRequestId(requestId: string): Promise<JobSummary | undefined>;
  /**
   * Permanently remove a finished (completed/failed/interrupted) job and its persisted state
   * (record, control intents, completion events/acks, logs, and its spec when no other job shares it).
   * Refuses any job that is not terminal under fresh liveness evidence (`invalid-state`).
   */
  deleteJob(jobIdOrPrefix: string): Promise<void>;
  /**
   * Reconcile possibly-orphaned jobs (startup sweep): `running`/`unknown` jobs, plus
   * `accepted`/`starting` jobs created more than `olderThanMs` ago (default 2 min).
   * Per-job failures are skipped, not thrown.
   */
  reconcile(opts?: { olderThanMs?: number }): Promise<JobSummary[]>;
}

export type Coordinator = CoordinatorClient & CoordinatorExtensions;

/** Bounded retry policy for coordinator-lock contention during admission; overridable for tests. */
export interface AdmissionRetryOptions {
  /** Total attempts including the first (default 10). */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Uniform [0, 1) jitter source. */
  random?: () => number;
}

export interface CreateCoordinatorOptions {
  root?: string;
  /** Test hook: override the admission lock-retry policy. */
  admissionRetry?: AdmissionRetryOptions;
}

const START_POLL_WINDOW_MS = 2000;
const START_POLL_INTERVAL_MS = 100;
const WAIT_FALLBACK_POLL_INTERVAL_MS = 500;
const ADMISSION_LOCK_MAX_ATTEMPTS = 10;
const ADMISSION_LOCK_MIN_DELAY_MS = 20;
const ADMISSION_LOCK_MAX_DELAY_MS = 100;
/** Accepted/starting jobs younger than this are assumed to still be launching. */
const DEFAULT_RECONCILE_OLDER_THAN_MS = 2 * 60 * 1000;

function socketPathFor(root: string, jobId: string): string {
  return getSocketPath(root, socketNameForJob(jobId));
}

function toJobSummary(record: JobRecord): JobSummary {
  return {
    abandonment: record.abandonment,
    uncertaintyReason: record.uncertaintyReason,
    jobId: record.jobId,
    requestId: record.requestId,
    state: record.state,
    stopState: record.stopState,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
  };
}

function toConsentSpec(spec: LaunchSpec): ConsentRelevantSpec {
  const { requestId: _requestId, createdAt: _createdAt, ...rest } = spec;
  return rest;
}

function logsDirFor(root: string, jobId: string): string {
  // Must match supervisor/lifecycle.ts's `logsDir()`; used when the supervisor's IPC is unreachable.
  return join(root, "jobs", jobId, "logs");
}

async function findJobByRequestId(repositories: Repositories, requestId: string): Promise<JobRecord | undefined> {
  // No requestId index exists, so scan the (small) job list. Normally at most one match;
  // if several, prefer the newest `startedAt`.
  const all = await repositories.jobs.list();
  let newest: JobRecord | undefined;
  for (const job of all) {
    if (job.requestId !== requestId) continue;
    if (newest === undefined || (job.startedAt ?? "") > (newest.startedAt ?? "")) newest = job;
  }
  return newest;
}

/**
 * Run `fn` under the coordinator lock, retrying (jittered backoff) only on `lock-held`
 * raised while ACQUIRING the lock. `fn` never runs more than once, so check-then-create
 * stays atomic; errors from `fn` propagate immediately.
 */
async function withCoordinatorLockRetrying<T>(
  root: string,
  fn: () => Promise<T>,
  opts: AdmissionRetryOptions | undefined,
): Promise<T> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? ADMISSION_LOCK_MAX_ATTEMPTS);
  const sleepFn = opts?.sleep ?? sleep;
  const random = opts?.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let fnStarted = false;
    try {
      return await withCoordinatorLock(root, () => {
        fnStarted = true;
        return fn();
      });
    } catch (error) {
      if (fnStarted || !(error instanceof BackgroundJobError) || error.code !== "lock-held") throw error;
      lastError = error;
      if (attempt < maxAttempts - 1) {
        const span = ADMISSION_LOCK_MAX_DELAY_MS - ADMISSION_LOCK_MIN_DELAY_MS;
        const jitter = Math.min(span, Math.max(0, Math.floor(random() * (span + 1))));
        await sleepFn(ADMISSION_LOCK_MIN_DELAY_MS + jitter);
      }
    }
  }
  throw lastError;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Short bounded retry for `jobs.update()` racing the job's own supervisor process (e.g. our
 * post-launch supervisor-ownership write vs its startup `{ state: "starting", nonce }` update).
 * `acquireLock` never retries/steals. Allow two seconds of backoff for transient
 * publication contention on busy hosts, then surface a persistently held lock.
 */
async function updateJobRetryingOnLockHeld(
  repos: Repositories,
  jobId: string,
  patch: Partial<JobRecord>,
): Promise<void> {
  const attempts = 21;
  const delayMs = 100;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await repos.jobs.update(jobId, patch);
      return;
    } catch (error) {
      if (!(error instanceof BackgroundJobError) || error.code !== "lock-held") throw error;
      lastError = error;
      if (attempt < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastError;
}

/** IPC round-trip to the supervisor; returns `undefined` (never throws) if unreachable so callers can fall back. */
async function tryIpcRequest(socketPath: string, request: unknown, timeoutMs = 5000): Promise<unknown | undefined> {
  let client: IpcClient | undefined;
  try {
    client = await IpcClient.connectWithRetry(socketPath, { retries: 1, delayMs: 100, timeoutMs: 1500 });
    return await client.request(request, timeoutMs);
  } catch {
    return undefined;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

export async function createCoordinator(opts?: CreateCoordinatorOptions): Promise<Coordinator> {
  const root = await resolveStorageRoot(opts?.root);
  // Refuse a store stamped by a newer build before touching it; never rewrite an existing marker.
  await checkStorageVersion(root);
  await ensureStorageVersionFile(root);
  const repositories = createFileRepositories(root);
  const authorizationService = createAuthorizationService(root);
  const mailboxService = createMailboxService(repositories);

  async function resolveJobId(jobIdOrPrefix: string): Promise<string> {
    return repositories.jobs.resolvePrefix(jobIdOrPrefix);
  }

  async function requireSpecForJob(record: JobRecord): Promise<LaunchSpec> {
    const spec = await repositories.specs.get(record.requestId);
    if (spec === undefined) {
      throw new BackgroundJobError(
        "not-found",
        `No LaunchSpec found for requestId "${record.requestId}" (job "${record.jobId}").`,
      );
    }
    return spec;
  }

  /** Best effort display info from the persisted spec; a missing/unreadable spec must not break list/poll. */
  async function launchInfo(record: JobRecord): Promise<Pick<JobSummary, "command" | "cwd">> {
    try {
      const spec = await repositories.specs.get(record.requestId);
      if (spec === undefined) return {};
      const { invocation } = spec;
      const command = invocation.mode === "shell"
        ? invocation.commandText
        : [invocation.executable, ...invocation.args].join(" ");
      return { command, cwd: spec.cwd };
    } catch {
      return {};
    }
  }

  async function withLaunchInfo(record: JobRecord): Promise<JobSummary> {
    return { ...toJobSummary(record), ...(await launchInfo(record)) };
  }

  async function reconcileAndSummarize(jobId: string): Promise<{ record: JobRecord; summary: JobSummary }> {
    const result = await reconcileJob({
      jobId,
      repositories,
      root,
      socketPathFor: (id) => socketPathFor(root, id),
    });
    return { record: result.record, summary: toJobSummary(result.record) };
  }

  /** Best effort: the schedule that launched `record`, found through its occurrences. */
  async function confirmSubjectFor(record: JobRecord): Promise<ConfirmSubject> {
    const subject: ConfirmSubject = { jobId: record.jobId };
    try {
      for (const schedule of await repositories.schedules.list()) {
        const occurrences = await repositories.occurrences.listForSchedule(schedule.scheduleId);
        if (occurrences.some((o) => o.requestId === record.requestId)) {
          subject.parent = { scheduleId: schedule.scheduleId, cron: schedule.cron };
          break;
        }
      }
    } catch {
      // Display-only; an unreadable schedule store must not block a stop.
    }
    return subject;
  }

  async function authorizeOrThrow(
    action: "start" | "stop" | "cleanup",
    spec: ConsentRelevantSpec,
    session: SessionPolicySnapshot,
    opts2?: { headless?: boolean; subject?: ConfirmSubject },
  ): Promise<void> {
    const decision = await authorizationService.authorize(action, spec, session, opts2);
    if (!decision.allowed) {
      throw new BackgroundJobError("authorization-denied", decision.reason);
    }
  }

  const client: Coordinator = {
    async start(request: StartJobRequest, session: SessionPolicySnapshot): Promise<JobSummary> {
      const adapter = await getPlatformAdapter();

      // Schedule dispatch: launch from the exact template the schedule grant
      // covers, never from the caller's own fields or session. The grant is
      // revalidated against that template below instead of re-authorizing.
      const approved = request.scheduleGrant?.template;
      if (request.scheduleGrant !== undefined && approved !== undefined) {
        const grantDecision = await authorizationService.revalidateBeforeDispatch(
          request.scheduleGrant.grantId,
          approved,
        );
        if (!grantDecision.allowed) {
          throw new BackgroundJobError("authorization-denied", grantDecision.reason);
        }
      }
      const invocation = approved?.invocation ?? request.invocation;
      const cwd = approved?.cwd ?? request.cwd;
      const requestedIsolation = approved?.isolation ?? request.isolation;
      const headless = approved === undefined ? request.headless : approved.headless;

      // Resolve isolation BEFORE spending any authorization/capacity effort.
      const capabilities = await adapter.detectCapabilities();
      const isolationResolution = authorizationService.resolveIsolation(requestedIsolation, capabilities);
      // Discovery alone cannot enforce isolation: the current supervisor
      // only implements bare workload spawn. Refuse rather than downgrade.
      if (requestedIsolation.backend !== "none" && !isolationResolution.refused) {
        throw new BackgroundJobError(
          "isolation-unavailable",
          `Background workload isolation backend "${requestedIsolation.backend}" is not implemented. Request explicit backend "none" only with unrestricted-execution consent.`,
        );
      }
      if (isolationResolution.refused) {
        throw new BackgroundJobError(
          "isolation-unavailable",
          isolationResolution.reason ?? "Requested isolation backend is unavailable on this host.",
        );
      }

      const spec = await normalizeLaunchSpec({
        requestId: request.requestId,
        invocation,
        cwd,
        platform: adapter.platform,
        isolation: requestedIsolation,
        // Always the adapter's strongest scope; per-request scopes are not negotiated.
        ownershipScope: capabilities.strongestOwnershipScope,
        envInherit: approved === undefined ? request.envInherit : undefined,
        // Schedule dispatch uses the approved template's env/limits/recurrence.
        env: approved === undefined ? request.env : approved.env,
        envExact: approved !== undefined,
        limits: approved === undefined ? request.limits : approved.limits,
        recurrence: approved?.recurrence,
        headless,
        canonicalizeCwd: (path) => adapter.canonicalizePath(path),
      });

      const consentSpec = toConsentSpec(spec);

      // Schedule dispatch was already authorized by grant revalidation above; it must not mint a fresh grant.
      if (approved === undefined) {
        await authorizeOrThrow("start", consentSpec, session, { headless });
      }

      // Request identity, capacity check and job creation share one coordinator-lock transaction so
      // concurrent identical requests cannot both observe "not found" and launch twice.
      const admission = await withCoordinatorLockRetrying<{ existing: JobRecord } | { jobId: string }>(root, async () => {
        const newHash = hashLaunchSpecForConsent(consentSpec);
        let specToStore = spec;

        // Idempotent retry: a reused requestId returns the existing job.
        const existingSpec = await repositories.specs.get(request.requestId);
        if (existingSpec !== undefined) {
          if (hashLaunchSpecForConsent(toConsentSpec(existingSpec)) !== newHash) {
            throw new BackgroundJobError(
              "spec-changed",
              "Request ID reused with different launch specification.",
            );
          }
          const existingJob = await findJobByRequestId(repositories, request.requestId);
          if (existingJob !== undefined) return { existing: existingJob };
          // Crash between specs.put and jobs.create on a prior attempt: the consent hash matches, so
          // reuse the persisted spec (its original createdAt) instead of rewriting it, then admit.
          specToStore = existingSpec;
        }

        // Schedule dispatch: prove (atomically with job creation) that this dispatch is still owned.
        await request.scheduleGrant?.beforeAdmit?.();

        const reservation = await reserveCapacity(repositories, root, spec.limits);
        if (!reservation.granted) {
          throw new BackgroundJobError(
            "capacity-exceeded",
            `Concurrent job limit reached (${reservation.activeCount}/${spec.limits.maxConcurrentJobs}).`,
          );
        }

        await repositories.specs.put(specToStore);

        const newJobId = randomUUID();
        const record: JobRecord = {
          jobId: newJobId,
          requestId: request.requestId,
          specHash: newHash,
          protocolVersion: BACKGROUND_JOBS_PROTOCOL_VERSION,
          state: "accepted",
          stopState: "none",
          // Placeholder; the supervisor sets the real handshake nonce on its first update.
          nonce: "",
        };
        await repositories.jobs.create(record);
        return { jobId: newJobId };
      }, opts?.admissionRetry);

      if ("existing" in admission) return toJobSummary(admission.existing);
      const jobId = admission.jobId;

      // Inherited values travel only in the supervisor's process environment, never in the stored spec.
      const inheritedEnv: Record<string, string> = {};
      for (const name of spec.envInherit ?? []) {
        const value = process.env[name];
        if (value !== undefined) inheritedEnv[name] = value;
      }

      // Launch OUTSIDE the coordinator lock; never hold it while spawning.
      let launchResult;
      try {
        launchResult = await launchSupervisorForJob({ jobId, requestId: request.requestId, root, repositories, inheritedEnv });
      } catch (error) {
        // A definite pre-spawn failure means nothing ever ran: terminalize the job so its capacity
        // reservation is released. Ambiguous failures keep the reservation for reconciliation.
        if (error instanceof PreSpawnLaunchError) {
          await updateJobRetryingOnLockHeld(repositories, jobId, {
            state: "failed",
            endedAt: new Date().toISOString(),
            exitCode: null,
            uncertaintyReason: `Supervisor launch failed before spawn: ${error.message}`,
          }).catch(() => undefined);
        }
        throw error;
      }

      // Persist the supervisor's identity so cleanup() can reap it. A shallow-merge patch on
      // fields disjoint from the supervisor's own writes (state/nonce); the job lock serializes the update.
      await updateJobRetryingOnLockHeld(repositories, jobId, {
        supervisorIdentity: launchResult.identity,
        supervisorOwnershipHandle: launchResult.ownershipHandle,
        supervisorOwnershipScope: launchResult.ownershipScope,
      });

      // Short bounded poll: start() must not block until completion.
      const deadline = Date.now() + START_POLL_WINDOW_MS;
      let latest = await repositories.jobs.get(jobId);
      while (latest !== undefined && latest.state === "accepted" && Date.now() < deadline) {
        await sleep(START_POLL_INTERVAL_MS);
        latest = await repositories.jobs.get(jobId);
      }
      if (latest === undefined) {
        throw new BackgroundJobError("not-found", `JobRecord for jobId "${jobId}" disappeared immediately after creation.`);
      }
      return toJobSummary(latest);
    },

    async list(): Promise<JobSummary[]> {
      const records = await repositories.jobs.list();
      return Promise.all(records.map(withLaunchInfo));
    },

    async poll(jobIdOrPrefix: string): Promise<JobSummary> {
      const jobId = await resolveJobId(jobIdOrPrefix);
      const { record, summary } = await reconcileAndSummarize(jobId);
      return { ...summary, ...(await launchInfo(record)) };
    },

    async log(jobIdOrPrefix: string, logOpts?: { maxBytes?: number; cursor?: string; stream?: LogStream }): Promise<LogTail> {
      const jobId = await resolveJobId(jobIdOrPrefix);
      const socketPath = socketPathFor(root, jobId);
      const stream = logOpts?.stream ?? "stdout";

      const reply = await tryIpcRequest(socketPath, {
        type: "log",
        maxBytes: logOpts?.maxBytes,
        cursor: logOpts?.cursor,
        stream,
      });

      if (reply !== undefined && isLogResponse(reply)) {
        return { text: reply.text, truncated: reply.truncated, cursor: reply.cursor ?? logOpts?.cursor ?? "" };
      }

      // Supervisor unreachable: read from disk so logs outlive the supervisor process.
      const dir = logsDirFor(root, jobId);
      if (logOpts?.cursor !== undefined || logOpts?.maxBytes === undefined) {
        const result = await readCursor(dir, stream, logOpts?.cursor, logOpts?.maxBytes);
        return { text: result.text, truncated: result.truncated, cursor: result.cursor };
      }
      const result = await readTail(dir, stream, logOpts.maxBytes);
      return { text: result.text, truncated: result.truncated, cursor: "" };
    },

    async wait(jobIdOrPrefix: string, signal?: AbortSignal): Promise<JobSummary> {
      const jobId = await resolveJobId(jobIdOrPrefix);

      const initial = await client.poll(jobId);
      if (isTerminalLifecycle(initial.state)) {
        return initial;
      }

      const socketPath = socketPathFor(root, jobId);

      // IpcClient.request() has no AbortSignal support, so race it against `signal` here;
      // cancellation only releases the observer and returns current state.
      let ipcClient: IpcClient | undefined;
      try {
        ipcClient = await IpcClient.connectWithRetry(socketPath, { retries: 1, delayMs: 100, timeoutMs: 1500 });
      } catch {
        ipcClient = undefined;
      }

      if (ipcClient !== undefined) {
        const connectedClient = ipcClient;
        try {
          const result = await new Promise<{ cancelled: boolean; reply?: unknown }>((resolve) => {
            let settled = false;
            const onAbort = () => {
              if (settled) return;
              settled = true;
              resolve({ cancelled: true });
            };
            if (signal) {
              if (signal.aborted) {
                onAbort();
                return;
              }
              signal.addEventListener("abort", onAbort, { once: true });
            }
            connectedClient
              .request({ type: "wait" }, 24 * 60 * 60 * 1000)
              .then((reply) => {
                if (settled) return;
                settled = true;
                if (signal) signal.removeEventListener("abort", onAbort);
                resolve({ cancelled: false, reply });
              })
              .catch(() => {
                if (settled) return;
                settled = true;
                if (signal) signal.removeEventListener("abort", onAbort);
                resolve({ cancelled: true });
              });
          });

          if (result.cancelled || result.reply === undefined || !isWaitResponse(result.reply)) {
            return client.poll(jobId);
          }
          if (result.reply.job !== undefined) {
            return toJobSummary(result.reply.job);
          }
          return client.poll(jobId);
        } finally {
          await connectedClient.close().catch(() => {});
        }
      }

      // IPC unreachable (supervisor may have exited after a terminal state): poll until terminal or cancelled.
      while (true) {
        if (signal?.aborted) {
          return client.poll(jobId);
        }
        const polled = await client.poll(jobId);
        if (isTerminalLifecycle(polled.state)) {
          return polled;
        }
        await sleep(WAIT_FALLBACK_POLL_INTERVAL_MS);
      }
    },

    async stop(jobIdOrPrefix: string, session: SessionPolicySnapshot): Promise<JobSummary> {
      const jobId = await resolveJobId(jobIdOrPrefix);
      const record = await repositories.jobs.get(jobId);
      if (record === undefined) {
        throw new BackgroundJobError("not-found", `No JobRecord found for jobId "${jobId}".`);
      }
      // Fresh liveness evidence first: only a live job can be stopped, so anything else
      // (finished, unknown, recovery-required) is reported as-is without asking for approval.
      const current = await reconcileAndSummarize(jobId);
      if (!isLiveLifecycle(current.record.state)) return current.summary;

      const spec = await requireSpecForJob(record);
      const consentSpec = toConsentSpec(spec);

      await authorizeOrThrow("stop", consentSpec, session, { subject: await confirmSubjectFor(record) });

      const socketPath = socketPathFor(root, jobId);
      const reply = await tryIpcRequest(socketPath, { type: "stop" }, 15000);

      if (reply !== undefined && isStopResponse(reply) && reply.job !== undefined) {
        return toJobSummary(reply.job);
      }

      // Supervisor likely gone: report reconciled state rather than claiming a stop succeeded.
      const { summary } = await reconcileAndSummarize(jobId);
      return summary;
    },

    async cleanup(jobIdOrPrefix: string, session: SessionPolicySnapshot): Promise<void> {
      const jobId = await resolveJobId(jobIdOrPrefix);
      const record = await repositories.jobs.get(jobId);
      if (record === undefined) {
        throw new BackgroundJobError("not-found", `No JobRecord found for jobId "${jobId}".`);
      }
      const spec = await requireSpecForJob(record);
      const consentSpec = toConsentSpec(spec);

      await authorizeOrThrow("cleanup", consentSpec, session);

      // Re-check with fresh evidence: never clean up active/unknown jobs (protects ownership evidence).
      const { record: fresh } = await reconcileAndSummarize(jobId);
      if (!isTerminalLifecycle(fresh.state)) {
        throw new BackgroundJobError(
          "not-found",
          `Cannot clean up job "${jobId}": it is not in a terminal state (current state: "${fresh.state}"). ` +
            `Cleanup is refused for active/unknown/recovery-required jobs to protect ownership evidence.`,
        );
      }

      // Reap the idle supervisor now instead of waiting for its idle-exit timer, best-effort
      // (failures must not fail cleanup). A persisted PID may have been reused by unrelated
      // work, and a numeric group handle alone is not ownership, so weak identities and
      // mismatched leaders are skipped. Probe-then-signal is still a POSIX race.
      const identity = fresh.supervisorIdentity;
      if (fresh.supervisorOwnershipScope === "process-group" &&
          identity !== undefined &&
          fresh.supervisorOwnershipHandle === String(identity.pid) &&
          identity.creationIdentity !== "" &&
          identity.creationIdentity !== "unavailable" &&
          identity.creationIdentity !== String(identity.pid)) {
        try {
          const adapter = await getPlatformAdapter();
          if (!await adapter.verifyAlive(identity)) return;
          await adapter.stopOwnedScope(
            fresh.supervisorOwnershipHandle!,
            fresh.supervisorOwnershipScope ?? "unverified",
            3000,
          );
        } catch {
          // Best-effort only.
        }
      }

      // Known limitation: no log/record files are deleted yet (retention/export policy undecided).
    },

    async abandonJob(jobId: string, acknowledgeUnverified: boolean, session: SessionPolicySnapshot): Promise<JobSummary> {
      if (acknowledgeUnverified !== true || session.permissionMode === "deny-writes") {
        throw new BackgroundJobError("authorization-denied", "Explicitly acknowledge that outcome and descendants remain unverified; deny-writes forbids abandonment.");
      }
      if (await resolveJobId(jobId) !== jobId) throw new BackgroundJobError("invalid-state", "Abandonment requires the exact full job ID.");
      const reconciliation = await reconcileJob({
        jobId, repositories, root, socketPathFor: (id) => socketPathFor(root, id),
      });
      if (reconciliation.action === "reconnected") throw new BackgroundJobError("invalid-state", "Supervisor reconnected; use poll/stop instead of abandonment.");
      const observed = reconciliation.record;
      return withCoordinatorLockRetrying(root, () => withJobLock(root, jobId, async () => {
        const fresh = await repositories.jobs.get(jobId);
        if (!fresh) throw new BackgroundJobError("not-found", "Job disappeared.");
        if (fresh.abandonment) return toJobSummary(fresh);
        if ((fresh.state !== "recovery-required" && fresh.state !== "unknown")
          || JSON.stringify(fresh) !== JSON.stringify(observed)) {
          throw new BackgroundJobError("invalid-state", "Job reconnected, changed or is not uncertain; inspect it again before abandoning.");
        }
        // Atomic audit, spawn fence and capacity release; no terminal claim.
        await repositories.jobs.update(jobId, { abandonment: {
          abandonedAt: new Date().toISOString(),
          acknowledgement: "outcome-and-descendants-unverified",
          previousState: fresh.state, previousNonce: fresh.nonce,
        } });
        return toJobSummary((await repositories.jobs.get(jobId))!);
      }), opts?.admissionRetry);
    },

    async deleteJob(jobIdOrPrefix: string): Promise<void> {
      const jobId = await resolveJobId(jobIdOrPrefix);
      if ((await repositories.jobs.get(jobId)) === undefined) {
        throw new BackgroundJobError("not-found", `No JobRecord found for jobId "${jobId}".`);
      }
      // Fresh liveness evidence, gathered OUTSIDE the lock (it can take seconds). Only a stored
      // terminal state is trusted below, and terminal states are never re-written.
      try {
        await reconcileAndSummarize(jobId);
      } catch (error) {
        // A concurrent delete may have removed the record mid-reconcile.
        if ((await repositories.jobs.get(jobId)) === undefined) {
          throw new BackgroundJobError("not-found", `No JobRecord found for jobId "${jobId}".`);
        }
        throw error;
      }

      // Same lock as admission, so a concurrent delete or same-request retry cannot interleave:
      // everything below is re-read inside it. Without this, a stale "no one shares this spec" check
      // could delete the spec of a job a retry created after the first delete.
      await withCoordinatorLockRetrying(root, async () => {
        const fresh = await repositories.jobs.get(jobId);
        if (fresh === undefined) {
          throw new BackgroundJobError("not-found", `No JobRecord found for jobId "${jobId}".`);
        }
        if (!isTerminalLifecycle(fresh.state)) {
          throw new BackgroundJobError(
            "invalid-state",
            `Cannot delete job "${jobId}": it is not finished (state: "${fresh.state}"). Only completed, failed or interrupted jobs can be deleted.`,
          );
        }

        // Best-effort pieces first, the JobRecord last: until it is gone the job stays listed and the delete can be retried.
        await repositories.controlIntents.deleteForJob(jobId);
        await repositories.events.deleteForJob(jobId);
        await rm(join(root, "jobs", jobId), { recursive: true, force: true });
        const sharesSpec = (await repositories.jobs.list()).some((j) => j.jobId !== jobId && j.requestId === fresh.requestId);
        if (!sharesSpec) await repositories.specs.delete(fresh.requestId);
        await repositories.jobs.delete(jobId);
      }, opts?.admissionRetry);
    },

    async capabilities(): Promise<PlatformCapabilities> {
      const adapter = await getPlatformAdapter();
      return adapter.detectCapabilities();
    },

    async findByRequestId(requestId: string): Promise<JobSummary | undefined> {
      const record = await findJobByRequestId(repositories, requestId);
      return record === undefined ? undefined : toJobSummary(record);
    },

    async reconcile(reconcileOpts?: { olderThanMs?: number }): Promise<JobSummary[]> {
      const olderThanMs = reconcileOpts?.olderThanMs ?? DEFAULT_RECONCILE_OLDER_THAN_MS;
      const cutoff = Date.now() - olderThanMs;
      const results: JobSummary[] = [];
      for (const record of await repositories.jobs.list()) {
        try {
          let eligible = record.state === "running" || record.state === "unknown";
          if (record.state === "accepted" || record.state === "starting") {
            // JobRecord has no creation time; use the LaunchSpec's `createdAt`. Missing/unparseable counts as old.
            const spec = await repositories.specs.get(record.requestId);
            const createdMs = spec === undefined ? Number.NaN : Date.parse(spec.createdAt);
            eligible = Number.isNaN(createdMs) || createdMs <= cutoff;
          }
          if (!eligible) continue;
          const { summary } = await reconcileAndSummarize(record.jobId);
          results.push(summary);
        } catch {
          // Best-effort sweep: one unreadable/contended job must not stop the rest.
        }
      }
      return results;
    },

    mailbox: mailboxService,
    repositories,
    authorization: authorizationService,
    root,
  };

  return client;
}

interface LogResponseShape {
  type: "log";
  text: string;
  truncated: boolean;
  cursor?: string;
}

function isLogResponse(msg: unknown): msg is LogResponseShape {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "log" &&
    typeof (msg as Record<string, unknown>).text === "string"
  );
}

interface StopResponseShape {
  type: "stop";
  job: JobRecord | undefined;
}

function isStopResponse(msg: unknown): msg is StopResponseShape {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "stop";
}

interface WaitResponseShape {
  type: "wait";
  job: JobRecord | undefined;
}

function isWaitResponse(msg: unknown): msg is WaitResponseShape {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "wait";
}
