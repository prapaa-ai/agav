/**
 * T14 — The coordinator: the one entry point through which every background
 * job tool/slash-command/headless client/schedule must pass (per the
 * `CoordinatorClient` doc in types.ts). This file is the only module in
 * this subsystem allowed to import authorization, launch-spec normalization,
 * supervisor launching, recovery and mailbox together (README.md).
 *
 * Boundaries honored here:
 *   - Pure launch-spec validation lives in `../launch-spec/normalize.js`
 *     (T07); this file only supplies the platform/filesystem hooks it needs.
 *   - All authorization decisions go through `../authorization/service.js`
 *     (T08); this file never re-implements grant/consent logic.
 *   - Capacity bookkeeping is `./admission.js`; actually starting the
 *     supervisor process is `./launcher.js`. Both are deliberately split out
 *     so this file stays an orchestration script, not a grab-bag.
 *   - Fresh liveness evidence for `poll`/`wait`/`stop` comes from
 *     `../recovery/reconcile.js` (T12) rather than trusting stale on-disk
 *     state, exactly as solution.md §6 requires.
 *   - Completion-event access for T16's future notification UI is exposed
 *     via the `mailbox` extension property (see bottom of this file) backed
 *     by `../mailbox/mailbox-service.js` (T13).
 *
 * Schedule engine (T15) extension point: `CoordinatorClient` intentionally
 * has no schedule methods yet (T15 is a separate, not-yet-built task per
 * subtasks.md). `../types.ts`'s module-boundary comment documents
 * `schedule-engine.ts -> consumes storage + authorization + coordinator
 * client API`, i.e. T15 is expected to consume the `CoordinatorClient`
 * returned by `createCoordinator()` from the *outside*, the same way T16's
 * tools/commands do, rather than this file reaching into scheduling logic.
 * No scheduling code is implemented here; this is a documented extension
 * point, not a stub method.
 */
import { randomUUID } from "node:crypto";

import {
  BACKGROUND_JOBS_PROTOCOL_VERSION,
  BackgroundJobError,
  isTerminalLifecycle,
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
import { resolveStorageRoot } from "../storage/paths.js";
import { createFileRepositories } from "../storage/repositories.js";
import { withCoordinatorLock } from "../storage/single-writer-lock.js";
import { createAuthorizationService, type AuthorizationService } from "../authorization/service.js";
import { hashLaunchSpecForConsent, type ConsentRelevantSpec } from "../authorization/spec-hash.js";
import { normalizeLaunchSpec } from "../launch-spec/normalize.js";
import { getPlatformAdapter } from "../platform/index.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { IpcClient } from "../ipc/client.js";
import { reconcileJob } from "../recovery/reconcile.js";
import { createMailboxService, type MailboxService } from "../mailbox/mailbox-service.js";
import { readCursor, readTail } from "../logging/segment-reader.js";
import { reserveCapacity } from "./admission.js";
import { launchSupervisorForJob, socketNameForJob } from "./launcher.js";
import { join } from "node:path";

/**
 * Extension surface beyond the frozen `CoordinatorClient` interface.
 * `CoordinatorClient` does not forbid additional properties, and T16 needs a
 * way to reach the mailbox/repositories/authorization service directly for
 * notification presentation and advanced/debugging use — see task brief.
 * These are NOT part of the frozen contract; callers that only hold a
 * `CoordinatorClient`-typed reference cannot see them.
 */
export interface CoordinatorExtensions {
  mailbox: MailboxService;
  repositories: Repositories;
  authorization: AuthorizationService;
  /** Resolved, canonicalized storage root this coordinator instance is bound to. */
  root: string;
}

export type Coordinator = CoordinatorClient & CoordinatorExtensions;

export interface CreateCoordinatorOptions {
  root?: string;
}

const START_POLL_WINDOW_MS = 2000;
const START_POLL_INTERVAL_MS = 100;
const WAIT_FALLBACK_POLL_INTERVAL_MS = 500;

function socketPathFor(root: string, jobId: string): string {
  return getSocketPath(root, socketNameForJob(jobId));
}

function toJobSummary(record: JobRecord): JobSummary {
  return {
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
  // Mirrors `Omit<LaunchSpec, 'requestId' | 'createdAt'>` structurally;
  // destructure explicitly rather than relying on object-shape coincidence
  // so a future LaunchSpec field addition is forced through this file too.
  const { requestId: _requestId, createdAt: _createdAt, ...rest } = spec;
  return rest;
}

function logsDirFor(root: string, jobId: string): string {
  // MUST match supervisor/lifecycle.ts's private `logsDir()` derivation
  // exactly, since this is the fallback path once a supervisor's IPC
  // connection is no longer reachable (solution.md: "logs must outlive the
  // live IPC connection").
  return join(root, "jobs", jobId, "logs");
}

async function findJobByRequestId(repositories: Repositories, requestId: string): Promise<JobRecord | undefined> {
  // No dedicated requestId -> jobId index exists in the frozen Repositories
  // contract (see types.ts); `repositories.jobs.list()` + filter is the
  // documented acceptable approach for Phase B's expected small job counts
  // (see task brief).
  const all = await repositories.jobs.list();
  return all.find((job) => job.requestId === requestId);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded retry for a `repositories.jobs.update()` call that may transiently
 * contend with the job's own live supervisor (a different OS process)
 * writing its own update at roughly the same moment — e.g. Fix B's
 * post-launch `supervisorOwnershipHandle` persistence racing the
 * supervisor's own `{ state: "starting", nonce }` update at startup.
 * `PlatformAdapter.acquireLock` deliberately never retries/steals on
 * `lock-held` (solution.md §7: "a hung writer is unavailable until it exits
 * or is explicitly recovered") — that policy is correct for a genuinely
 * STUCK lock, but this contention only ever lasts a few milliseconds, so a
 * short bounded retry here is this call site's own decision about expected
 * transient contention, mirroring the identical pattern already used by
 * `recovery/reconcile.ts`'s `withJobLockRetrying`. If the lock is still held
 * after all retries, the `lock-held` error propagates untouched.
 */
async function updateJobRetryingOnLockHeld(
  repos: Repositories,
  jobId: string,
  patch: Partial<JobRecord>,
): Promise<void> {
  const attempts = 5;
  const delayMs = 30;
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

/**
 * Try an IPC round-trip against the job's running supervisor. Returns
 * `undefined` (never throws) if the supervisor is unreachable — callers
 * decide the appropriate fallback (disk-backed logs, `reconcileJob`, etc.)
 * per solution.md "logs must outlive the live IPC connection" and "a real
 * detached supervisor process might exit once terminal+IPC server closed".
 */
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

  async function reconcileAndSummarize(jobId: string): Promise<{ record: JobRecord; summary: JobSummary }> {
    const result = await reconcileJob({
      jobId,
      repositories,
      root,
      socketPathFor: (id) => socketPathFor(root, id),
    });
    return { record: result.record, summary: toJobSummary(result.record) };
  }

  async function authorizeOrThrow(
    action: "start" | "stop" | "cleanup",
    spec: ConsentRelevantSpec,
    session: SessionPolicySnapshot,
    opts2?: { headless?: boolean },
  ): Promise<void> {
    const decision = await authorizationService.authorize(action, spec, session, opts2);
    if (!decision.allowed) {
      throw new BackgroundJobError("authorization-denied", decision.reason);
    }
  }

  const client: Coordinator = {
    async start(request: StartJobRequest, session: SessionPolicySnapshot): Promise<JobSummary> {
      const adapter = await getPlatformAdapter();

      // (b) Resolve isolation BEFORE spending any authorization/capacity
      // effort — solution.md §4: "Determine the actual isolation backend
      // before approval. Required isolation unavailable means refusal."
      const capabilities = await adapter.detectCapabilities();
      const isolationResolution = authorizationService.resolveIsolation(request.isolation, capabilities);
      // Discovery alone cannot enforce isolation: the current supervisor
      // only implements bare workload spawn. Refuse rather than downgrade.
      if (request.isolation.backend !== "none" && !isolationResolution.refused) {
        throw new BackgroundJobError(
          "isolation-unavailable",
          `Background workload isolation backend "${request.isolation.backend}" is not implemented. Request explicit backend "none" only with unrestricted-execution consent.`,
        );
      }
      if (isolationResolution.refused) {
        throw new BackgroundJobError(
          "isolation-unavailable",
          isolationResolution.reason ?? "Requested isolation backend is unavailable on this host.",
        );
      }

      // (a) Normalize into a full LaunchSpec.
      const spec = await normalizeLaunchSpec({
        requestId: request.requestId,
        invocation: request.invocation,
        cwd: request.cwd,
        platform: adapter.platform,
        isolation: request.isolation,
        // This coordinator only implements the baseline POSIX/Windows
        // process-group / job-object ownership scope that each platform
        // adapter reports as its strongest; stronger per-request scopes
        // are not negotiated at this layer in Phase B.
        ownershipScope: capabilities.strongestOwnershipScope,
        envInherit: request.envInherit,
        headless: request.headless,
        canonicalizeCwd: (path) => adapter.canonicalizePath(path),
      });

      const consentSpec = toConsentSpec(spec);

      // (c) Authorize the start action.
      await authorizeOrThrow("start", consentSpec, session, { headless: request.headless });

      // (d) Idempotent retry handling.
      const existingSpec = await repositories.specs.get(request.requestId);
      if (existingSpec !== undefined) {
        const existingHash = hashLaunchSpecForConsent(toConsentSpec(existingSpec));
        const newHash = hashLaunchSpecForConsent(consentSpec);
        if (existingHash !== newHash) {
          throw new BackgroundJobError(
            "spec-changed",
            "Request ID reused with different launch specification.",
          );
        }

        const existingJob = await findJobByRequestId(repositories, request.requestId);
        if (existingJob === undefined) {
          // Spec was persisted but no job record exists yet (e.g. a crash
          // between spec.put and jobs.create during a prior attempt). Fall
          // through to normal admission below using the already-persisted,
          // byte-identical spec rather than re-normalizing/re-persisting.
        } else {
          return toJobSummary(existingJob);
        }
      }

      // (e) Admission: capacity check + job creation under the coordinator
      // lock, so check-then-create is atomic against concurrent admissions.
      const jobId = await withCoordinatorLock(root, async () => {
        const reservation = await reserveCapacity(repositories, root, spec.limits);
        if (!reservation.granted) {
          throw new BackgroundJobError(
            "capacity-exceeded",
            `Concurrent job limit reached (${reservation.activeCount}/${spec.limits.maxConcurrentJobs}).`,
          );
        }

        await repositories.specs.put(spec);

        const newJobId = randomUUID();
        const record: JobRecord = {
          jobId: newJobId,
          requestId: request.requestId,
          specHash: hashLaunchSpecForConsent(consentSpec),
          protocolVersion: BACKGROUND_JOBS_PROTOCOL_VERSION,
          state: "accepted",
          stopState: "none",
          // The supervisor itself establishes the real handshake nonce once
          // it starts (see supervisor/lifecycle.ts#start: `const nonce =
          // randomUUID(); await this.updateJob({ state: "starting", nonce
          // });`). An empty placeholder here is intentionally overwritten by
          // that very first supervisor update, matching T11's actual
          // behavior.
          nonce: "",
        };
        await repositories.jobs.create(record);
        return newJobId;
      });

      // (f) Launch OUTSIDE the coordinator lock — never hold a lock while
      // spawning a process.
      const launchResult = await launchSupervisorForJob({ jobId, requestId: request.requestId, root, repositories });

      // (f2) Fix B: persist the SUPERVISOR's own process identity/ownership
      // onto the job record immediately, before the short poll window
      // below, so a later `cleanup()` call can terminate the supervisor
      // process itself via `PlatformAdapter.stopOwnedScope` (see
      // launcher.ts's module doc and types.ts's JobRecord doc). This is a
      // shallow-merge patch (see storage/repositories.ts#update: `{
      // ...existing, ...patch }`), so it cannot clobber fields the
      // supervisor's OWN concurrent `jobs.update()` calls are writing (e.g.
      // `state`/`nonce`) — the two writers only ever touch disjoint field
      // sets, and the file lock (`withJobLock`) still serializes the
      // underlying read-modify-write so the merge itself is race-free.
      await updateJobRetryingOnLockHeld(repositories, jobId, {
        supervisorIdentity: launchResult.identity,
        supervisorOwnershipHandle: launchResult.ownershipHandle,
        supervisorOwnershipScope: launchResult.ownershipScope,
      });

      // (g) Short, bounded poll so start() returns quickly without blocking
      // until completion (solution.md §2).
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
      return records.map(toJobSummary);
    },

    async poll(jobIdOrPrefix: string): Promise<JobSummary> {
      const jobId = await resolveJobId(jobIdOrPrefix);
      const { summary } = await reconcileAndSummarize(jobId);
      return summary;
    },

    async log(jobIdOrPrefix: string, logOpts?: { maxBytes?: number; cursor?: string }): Promise<LogTail> {
      const jobId = await resolveJobId(jobIdOrPrefix);
      const socketPath = socketPathFor(root, jobId);

      const reply = await tryIpcRequest(socketPath, {
        type: "log",
        maxBytes: logOpts?.maxBytes,
        cursor: logOpts?.cursor,
      });

      if (reply !== undefined && isLogResponse(reply)) {
        return { text: reply.text, truncated: reply.truncated, cursor: reply.cursor ?? logOpts?.cursor ?? "" };
      }

      // Supervisor unreachable (terminal/unknown/exited): fall back to
      // reading directly from the job's log directory on disk, using the
      // SAME derivation JobSupervisor uses, so logs remain readable after
      // the supervisor process has exited.
      const dir = logsDirFor(root, jobId);
      if (logOpts?.cursor !== undefined || logOpts?.maxBytes === undefined) {
        const result = await readCursor(dir, "stdout", logOpts?.cursor, logOpts?.maxBytes);
        return { text: result.text, truncated: result.truncated, cursor: result.cursor };
      }
      const result = await readTail(dir, "stdout", logOpts.maxBytes);
      return { text: result.text, truncated: result.truncated, cursor: "" };
    },

    async wait(jobIdOrPrefix: string, signal?: AbortSignal): Promise<JobSummary> {
      const jobId = await resolveJobId(jobIdOrPrefix);

      const initial = await client.poll(jobId);
      if (isTerminalLifecycle(initial.state)) {
        return initial;
      }

      const socketPath = socketPathFor(root, jobId);

      // Race the IPC wait request against cancellation. IpcClient.request()
      // has no native AbortSignal support (see ipc/client.ts), so
      // cancellation is implemented at this layer: if `signal` fires first,
      // close the IPC client and return the last known poll() result
      // immediately — solution.md §6: "Cancellation or timeout of wait
      // releases only the observer and returns current state."
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

      // IPC unreachable: the supervisor may have already exited after
      // reaching a terminal state and closing its IPC server (T11's
      // documented design — see entry.ts/lifecycle.ts: the process has no
      // explicit keep-alive beyond its own open handles). Fall back to
      // polling `reconcileJob` until terminal or cancelled.
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
      const spec = await requireSpecForJob(record);
      const consentSpec = toConsentSpec(spec);

      // Per T08: 'stop' is never blocked by deny-writes, but still requires
      // its own grant/auto-accept/ask flow like any other action.
      await authorizeOrThrow("stop", consentSpec, session);

      const socketPath = socketPathFor(root, jobId);
      const reply = await tryIpcRequest(socketPath, { type: "stop" }, 15000);

      if (reply !== undefined && isStopResponse(reply) && reply.job !== undefined) {
        return toJobSummary(reply.job);
      }

      // Unreachable: the supervisor is likely already gone. Get a truthful
      // current state via reconciliation rather than claiming a stop
      // succeeded against a process that isn't there.
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

      // Re-check with fresh evidence before allowing cleanup of anything
      // that might still be active/unknown — solution.md §9: "Cleanup is
      // explicit and sensitive. Automatic log expiry does not delete
      // active/unknown ownership evidence."
      const { record: fresh } = await reconcileAndSummarize(jobId);
      if (!isTerminalLifecycle(fresh.state)) {
        throw new BackgroundJobError(
          "not-found",
          `Cannot clean up job "${jobId}": it is not in a terminal state (current state: "${fresh.state}"). ` +
            `Cleanup is refused for active/unknown/recovery-required jobs to protect ownership evidence.`,
        );
      }

      // Fix B (reaping): the job is confirmed terminal, so its supervisor
      // process (if still alive) is no longer doing anything useful except
      // waiting out its own idle-exit timer (see supervisor/lifecycle.ts's
      // SUPERVISOR_IDLE_EXIT_MS). `cleanup()` is an explicit, authorized
      // action, so it is safe to force this along immediately via the SAME
      // cross-platform `stopOwnedScope` abstraction already used for
      // workloads, but ONLY after fresh process-creation verification. This
      // is best-effort: a failure here (supervisor already exited, already
      // reaped, platform adapter error, ...) must never cause `cleanup()`
      // itself to throw, since the primary cleanup contract — authorizing
      // and confirming terminal state — already succeeded.
      // An unverified persisted PID may now belong to unrelated work. Leave
      // that supervisor to its own idle-exit timer rather than signalling it.
      // Terminal recovery returns records without probing supervisor identity.
      // A numeric group handle alone is not ownership; reject weak identities
      // and mismatched leaders. Probe then signal remains a best-effort POSIX
      // race, not retained native handle ownership.
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
          // Best-effort only; swallow per the doc above.
        }
      }

      // Phase-B simplification, documented per task brief: this
      // implementation authorizes, validates job state, and now (Fix B)
      // also terminates the job's own supervisor PROCESS once it is
      // confirmed terminal. Actual log/record FILE deletion policy is still
      // explicitly deferred to a future phase per solution.md §9's
      // "explicit and sensitive" cleanup requirements, to avoid prematurely
      // deleting evidence without a fully reviewed retention/export flow.
      // No data/log files are deleted by this call.
    },

    async capabilities(): Promise<PlatformCapabilities> {
      const adapter = await getPlatformAdapter();
      return adapter.detectCapabilities();
    },

    // --- Extensions beyond the frozen CoordinatorClient interface ---
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
