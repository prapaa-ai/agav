/**
 * T11 — Supervisor orchestration core.
 *
 * `JobSupervisor` is the process-independent orchestration core for a single
 * background job. It is constructed and driven directly by `entry.ts` when
 * running as a real detached OS process, and can equally be constructed and
 * driven directly by tests without ever going through a detached process
 * (per README.md: "supervisor/* ... does not depend on coordinator
 * lifetime", and per this task's brief: "independently testable WITHOUT
 * actually running as a detached OS process").
 *
 * Responsibilities owned here:
 *   - Spawning the workload as an owned child process (the supervisor is a
 *     plain Node process; it does NOT go through `source/utils/sandbox.ts`
 *     or any other process-launch helper — this is a `background-jobs/*`
 *     module and must stay self-contained per the module boundaries in
 *     types.ts/README.md).
 *   - Piping workload stdout/stderr into a `SegmentedLogWriter`.
 *   - Publishing the single authoritative `JobRecord` lifecycle through
 *     `repositories.jobs.update()` (never writing job state any other way).
 *   - Running an `IpcServer` so coordinator/test clients can poll/log/
 *     wait/stop this job without depending on the coordinator being alive.
 *   - Keeping "lifecycle" (JobRecord.state) and "stop-control"
 *     (JobRecord.stopState) strictly separate per solution.md §6: only the
 *     child's `exit` handler may set a terminal lifecycle state; only
 *     `requestStop` may advance stop-control state.
 *
 * Known simplifications (documented, not blocking per task brief):
 *   - `identity.creationIdentity` is stored as a minimal placeholder
 *     (`String(pid)`) at spawn time. A stronger creation-identity capture
 *     (e.g. `/proc/<pid>/stat` start time, matching
 *     `platform/linux.ts#readProcessStartTimePosix`) would reduce PID-reuse
 *     risk, but `PlatformAdapter` does not expose that primitive directly
 *     to non-platform callers (only `verifyAlive(identity)` does, and that
 *     requires an identity to already exist). This supervisor owns the
 *     child process handle directly for its entire lifetime (not just a
 *     bare pid), so reuse confusion is not actually possible from this
 *     process's own point of view; the placeholder only matters to
 *     *external* observers (e.g. recovery/T12) re-verifying after a
 *     supervisor crash, which is explicitly out of scope for T11.
 *   - `wait` is implemented as an in-process event-emitter resolved once on
 *     terminal state; IPC `wait` requests are answered by awaiting that
 *     promise so each client's `respond()` is deferred without blocking the
 *     IPC server from handling concurrent clients. There is no explicit
 *     server-side wait-cancellation message — a client cancels by closing
 *     its connection, which this minimal implementation and `IpcServer`
 *     already handle naturally (per task brief: the richer
 *     cancellation-aware coordinator-level wait is T14's job).
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { join } from "node:path";

/** stdin is "ignore" (null), stdout/stderr are piped so we can drain them. */
type WorkloadChild = ChildProcessByStdio<null, Readable, Readable>;

import type {
  CompletionEventRecord,
  JobRecord,
  LaunchSpec,
  Repositories,
  StopControlState,
} from "../types.js";
import { BackgroundJobError, isTerminalLifecycle } from "../types.js";
import { getPlatformAdapter } from "../platform/index.js";
import { buildShellInvocation } from "../launch-spec/shell.js";
import { SegmentedLogWriter } from "../logging/segment-writer.js";
import { buildCompletionExcerpt, readCursor, readTail } from "../logging/segment-reader.js";
import { describeLoggingFailureAction } from "../logging/failure-policy.js";
import { IpcServer } from "../ipc/server.js";

/** Default grace period given to the workload between SIGTERM and SIGKILL escalation. */
export const DEFAULT_STOP_GRACE_MS = 5000;

/**
 * Fix A (primary fix for "no code path can ever terminate a supervisor
 * process" — see task brief): once this job's lifecycle reaches a terminal
 * state (completed/failed/interrupted), the supervisor self-exits after
 * this much idle time (no IPC activity AND no currently-connected IPC
 * client) has elapsed. 5 minutes is intentionally generous so a user
 * polling/reading logs shortly after completion still finds the supervisor
 * alive to serve `poll`/`log`/`wait`, while still guaranteeing the process
 * does not leak forever. This NEVER fires before the job is terminal — an
 * in-progress job's supervisor must never self-exit while its workload
 * might still be running or its stop-control sequence might still be in
 * flight (T11's "the supervisor decides its own lifetime" design is
 * unchanged; this only bounds that lifetime once there is nothing left to
 * supervise).
 */
export const SUPERVISOR_IDLE_EXIT_MS = 5 * 60 * 1000;

/** How often the idle-exit timer re-checks elapsed-since-last-activity. */
const IDLE_EXIT_CHECK_INTERVAL_MS = 30 * 1000;

/** Bytes of stdout/stderr retained in a completion event's excerpt. */
const COMPLETION_EXCERPT_BYTES = 8 * 1024;

export interface JobSupervisorOptions {
  jobId: string;
  requestId: string;
  repositories: Repositories;
  root: string;
  socketPath: string;
  /** Overridable for fast tests; defaults to DEFAULT_STOP_GRACE_MS. */
  stopGraceMs?: number;
  /** Maximum duration of one log operation before retiring the writer. */
  logOperationTimeoutMs?: number;
  /** Overridable for fast tests; defaults to SUPERVISOR_IDLE_EXIT_MS. */
  idleExitMs?: number;
  /** Overridable for fast tests; defaults to IDLE_EXIT_CHECK_INTERVAL_MS (30s). */
  idleExitCheckIntervalMs?: number;
}

type PollResponse = { type: "poll"; job: JobRecord | undefined };
type LogResponse = { type: "log"; text: string; truncated: boolean; cursor?: string };
type StopResponse = { type: "stop"; job: JobRecord | undefined };
type WaitResponse = { type: "wait"; job: JobRecord | undefined };
type ErrorResponse = { type: "error"; message: string };

function logsDir(root: string, jobId: string): string {
  return join(root, "jobs", jobId, "logs");
}

export class JobSupervisor {
  private readonly jobId: string;
  private readonly requestId: string;
  private readonly repositories: Repositories;
  private readonly root: string;
  private readonly socketPath: string;
  private readonly stopGraceMs: number;
  private readonly logOperationTimeoutMs: number;
  private readonly idleExitMs: number;
  private readonly idleExitCheckIntervalMs: number;

  private child: WorkloadChild | undefined;
  private workloadOwnershipScope: LaunchSpec["ownershipScope"] = "process-group";
  private logWriteChain: Promise<void> = Promise.resolve();
  private logWriter: SegmentedLogWriter | undefined;
  private ipcServer: IpcServer | undefined;

  private stopRequested = false;
  private stopIntent: Promise<void> | undefined;
  private stopExecution: Promise<void> | undefined;
  private workloadPublished = false;
  private shellWorkload = false;
  private loggingFailure: string | undefined;
  private finalization: Promise<void> | undefined;
  private backgroundTasks = new Set<Promise<void>>();
  /** Signal our own stop logic sent, used to disambiguate a race at child exit. */
  private stopSignalSent: NodeJS.Signals | undefined;
  private started = false;

  private readonly terminalWaiters: Array<(job: JobRecord | undefined) => void> = [];
  private terminalJob: JobRecord | undefined;

  /** Updated at the very start of `handleIpcRequest`; see Fix A's idle-exit timer. */
  private lastActivityAt: number = Date.now();
  /** Set once the job goes terminal; cleared (and its interval cleared) by `shutdown()`/self-exit. */
  private idleExitInterval: NodeJS.Timeout | undefined;

  /**
   * `repositories.jobs.update()`'s underlying lock (acquireExclusiveLockPosix)
   * throws immediately on contention rather than queueing/retrying (by
   * design — see storage/single-writer-lock.ts doc). Within a single
   * supervisor process there can legitimately be two independent call sites
   * racing to update the same job (e.g. `requestStop`'s stop-control
   * updates and the child `exit` handler's terminal-lifecycle update). To
   * avoid spurious `lock-held` errors from that intra-process race, all
   * updates from this instance are serialized through this promise chain;
   * cross-process contention still relies on the lock itself.
   */
  private updateChain: Promise<void> = Promise.resolve();

  constructor(opts: JobSupervisorOptions) {
    this.jobId = opts.jobId;
    this.requestId = opts.requestId;
    this.repositories = opts.repositories;
    this.root = opts.root;
    this.socketPath = opts.socketPath;
    this.stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.logOperationTimeoutMs = opts.logOperationTimeoutMs ?? 5000;
    this.idleExitMs = opts.idleExitMs ?? SUPERVISOR_IDLE_EXIT_MS;
    this.idleExitCheckIntervalMs = opts.idleExitCheckIntervalMs ?? IDLE_EXIT_CHECK_INTERVAL_MS;
  }

  /**
   * Full launch sequence. See module doc / task brief for the step-by-step
   * contract. Never throws out of a confirmed-failure spawn; only throws for
   * genuine caller bugs (missing job record) or storage failures that
   * prevent any observation at all.
   */
  async start(spec: LaunchSpec): Promise<void> {
    if (this.started) return;
    // Persisted/older launch specs must not bypass the coordinator's refusal.
    // No isolation wrapper is implemented on this bare-spawn path.
    if (spec.isolation.backend !== "none") {
      throw new BackgroundJobError(
        "isolation-unavailable",
        `Background workload isolation backend "${spec.isolation.backend}" is not implemented.`,
      );
    }
    this.started = true;

    const existing = await this.repositories.jobs.get(this.jobId);
    if (existing === undefined) {
      throw new Error(
        `JobSupervisor.start: no JobRecord found for jobId "${this.jobId}". The caller must create an ` +
          `"accepted" JobRecord before spawning the supervisor (solution.md §6).`,
      );
    }

    const nonce = randomUUID();
    await this.updateJob({ state: "starting", nonce });

    // Start the IPC server as early as possible so pollers can observe
    // "starting" state even before the workload spawns.
    await this.startIpcServer();

    const { executable, args } =
      spec.invocation.mode === "direct"
        ? { executable: spec.invocation.executable, args: spec.invocation.args }
        : buildShellInvocation(spec.invocation.interpreter, spec.invocation.commandText);

    const dir = logsDir(this.root, this.jobId);
    const writer = new SegmentedLogWriter(dir, {
      segmentBytes: spec.limits.logSegmentBytes,
      retainedBytesPerJob: spec.limits.retainedLogBytesPerJob,
      onFailure: (reason) => {
        const action = describeLoggingFailureAction(reason);
        if (action.action === "request-stop" && !this.stopRequested) {
          // Fire-and-forget: logging failures must never throw out of the
          // write path (SegmentedLogWriter's own contract), and this
          // callback itself must not throw either.
          this.retireLogWriter(writer, new Error(action.diagnostic));
        }
      },
    });
    this.logWriter = writer;
    try {
      await this.boundedLogOperation(() => writer.init(), writer);
    } catch (error) {
      this.retireLogWriter(writer, error);
    }
    this.shellWorkload = spec.invocation.mode === "shell";

    const isWindows = process.platform === "win32";
    this.workloadOwnershipScope = isWindows ? "unverified" : "process-group";
    const isCmd = isWindows && spec.invocation.mode === "shell" && spec.invocation.interpreter === "cmd";
    // cmd parses command text, not CRT argv. /s strips this outer quote pair.
    const spawnArgs = isCmd ? [...args.slice(0, -1), `"${args.at(-1)}"`] : args;

    let child: WorkloadChild;
    try {
      child = spawn(executable, spawnArgs, {
        cwd: spec.cwd,
        env: spec.env,
        // POSIX needs a separate workload group; Windows shells need the
        // supervisor's hidden console to retain pipe/output behavior.
        detached: !isWindows,
        windowsHide: true,
        windowsVerbatimArguments: isCmd,
        stdio: ["ignore", "pipe", "pipe"],
      }) as WorkloadChild;
    } catch (error) {
      // Synchronous spawn throw (rare, but possible for some invalid
      // argument combinations). Treat identically to an async spawn error:
      // a confirmed, known terminal failure, not an uncertain one.
      await this.publishSpawnFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // IMPORTANT: attach 'error'/'exit' listeners synchronously, immediately
    // after spawn() returns — before any `await`. Node can emit 'exit' for
    // a very fast-completing child (e.g. `exit 7`, a quick `echo`) on the
    // next event-loop tick; if we only attached the real exit handler after
    // awaiting `writer.init()`/the ipc-server start/the jobs.update() calls
    // below, that event could already have fired and be silently lost
    // (EventEmitter does not replay past events to late listeners). Instead
    // we capture the terminal event (if any) into local state here and
    // process it below once the rest of the "running" setup is confirmed.
    let earlySpawnError: Error | undefined;
    let earlyClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let sawSpawn = false;
    let publishedRunning = false;
    child.on("error", (err) => {
      if (!sawSpawn && earlyClose === undefined) {
        earlySpawnError = err instanceof Error ? err : new Error(String(err));
      }
      // A late 'error' after we've already observed "running" (e.g. an
      // EPIPE on write) is intentionally not treated as a lifecycle event
      // here; `close` remains the single source of truth for terminal
      // lifecycle once the workload is confirmed running.
    });
    child.once("spawn", () => {
      sawSpawn = true;
    });
    // Also attach stdout/stderr drains synchronously (before any `await`)
    // so no output chunk emitted between a very fast process's spawn and
    // our setup below is ever missed.
    child.stdout.on("data", (chunk: Buffer) => {
      child.stdout.pause();
      this.queueLogWrite(writer, "stdout", chunk, child.stdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      child.stderr.pause();
      this.queueLogWrite(writer, "stderr", chunk, child.stderr);
    });
    // Use 'close' rather than 'exit' as the terminal lifecycle trigger:
    // 'exit' can fire before buffered stdout/stderr data has been fully
    // delivered for a very fast-completing child, which would race the
    // completion excerpt (buildCompletionExcerpt) against still-unflushed
    // log writes. 'close' is guaranteed to fire only after the stdio
    // streams themselves have ended (same convention as
    // source/utils/sandbox.ts's executeProcess, which uses 'close' for its
    // `finish` callback for the identical reason).
    child.on("close", (code, signal) => {
      earlyClose = { code, signal };
      if (publishedRunning) this.runBackground(this.finalizeChild(code, signal));
    });

    // Give the 'error'/'spawn' race a chance to resolve before deciding
    // whether the spawn itself succeeded.
    await new Promise<void>((resolve) => {
      if (sawSpawn || earlySpawnError) {
        resolve();
        return;
      }
      child.once("spawn", () => resolve());
      child.once("error", () => resolve());
    });

    if ((earlySpawnError && earlyClose === undefined) || child.pid === undefined) {
      await this.publishSpawnFailure(earlySpawnError ?? new Error("spawn failed: no pid assigned"));
      return;
    }

    this.child = child;

    await this.updateJob({
      state: "running",
      identity: {
        pid: child.pid,
        // Known simplification: see module doc "Known simplifications".
        creationIdentity: isWindows ? "unavailable" : String(child.pid),
      },
      ownershipHandle: String(child.pid),
      ownershipScope: this.workloadOwnershipScope,
      startedAt: new Date().toISOString(),
    });

    publishedRunning = true;
    this.workloadPublished = true;
    if (earlyClose) await this.finalizeChild(earlyClose.code, earlyClose.signal);
    if (this.stopRequested) await this.executeRequestedStop();

    // Fast close events are deferred until running is persisted; serialization
    // cannot correct a terminal update queued before the running update.
  }

  /** Own detached callbacks so teardown cannot race their durable publication. */
  private runBackground(task: Promise<void>): void {
    const handled = task.catch(error => {
      // Retain the last good on-disk state; never invent/acknowledge a result.
      console.error("background job supervisor operation failed:", error);
    }).finally(() => this.backgroundTasks.delete(handled));
    this.backgroundTasks.add(handled);
  }

  private finalizeChild(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.finalization ??= this.handleChildExit(code, signal);
    return this.finalization;
  }

  private async boundedLogOperation(operation: () => Promise<void>, writer: SegmentedLogWriter): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const pending = operation();
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("logging operation timed out")), this.logOperationTimeoutMs);
      })]);
    } catch (error) {
      // No new operation may ever use this writer. Its pending I/O is not
      // cancellable: close it ONLY after it settles, not concurrently with
      // append/rotation. A late completion cannot race a replacement writer.
      this.retireLogWriter(writer, error);
      void pending.then(() => writer.close(), () => writer.close()).catch(() => {});
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private retireLogWriter(writer: SegmentedLogWriter, error: unknown): void {
    if (this.loggingFailure) return;
    this.loggingFailure = "logging failure: " + (error instanceof Error ? error.message : String(error)) + "; output discarded; pending writer retired";
    if (this.logWriter === writer) this.logWriter = undefined;
    this.runBackground(this.updateJob({ uncertaintyReason: this.loggingFailure }));
    this.runBackground(this.requestStop(this.loggingFailure));
    this.child?.stdout.resume();
    this.child?.stderr.resume();
  }

  private queueLogWrite(writer: SegmentedLogWriter, stream: "stdout" | "stderr", chunk: Buffer, pipe: Readable): void {
    this.logWriteChain = this.logWriteChain.then(async () => {
      if (this.loggingFailure) return; // drain/discard, never reuse the retired writer
      try {
        await this.boundedLogOperation(() => writer.write(stream, chunk), writer);
      } catch { /* retirement already records failure and requests owned-child stop */ }
    }).finally(() => pipe.resume());
  }

  /** Serializes all job-record mutations from this instance (see `updateChain` doc). */
  private updateJob(patch: Partial<JobRecord>): Promise<void> {
    const next = this.updateChain.then(() => this.updateJobRetryingOnLockHeld(patch));
    // Swallow so a failed update doesn't poison the chain for subsequent
    // updates; callers that need to observe failure still get it via the
    // returned promise from this call.
    this.updateChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Bug fix (flaky "persists supervisorOwnershipHandle" test —
   * `coordinator.service.test.ts`): `repositories.jobs.update()`'s
   * underlying lock (`acquireExclusiveLockPosix`) throws immediately on
   * CROSS-PROCESS contention rather than queueing/retrying (by design —
   * see storage/single-writer-lock.ts's doc). `coordinator/service.ts#start`
   * persists `supervisorIdentity`/`supervisorOwnershipHandle` onto the job
   * record (Fix B) immediately after `launchSupervisorForJob` returns —
   * i.e. at almost exactly the same moment this just-spawned supervisor
   * process is making its own first `updateJob({state: "starting", nonce})`
   * call. Both writers target the SAME job record from two DIFFERENT OS
   * processes, so `updateChain`'s intra-process serialization (see its own
   * doc above) does not help here — only one of the two processes wins the
   * underlying O_EXCL lock file and the other gets a `lock-held` error.
   * `coordinator/service.ts` already defends its own side of this exact
   * race with `updateJobRetryingOnLockHeld` (mirroring
   * `recovery/reconcile.ts`'s `withJobLockRetrying`), but this supervisor
   * side had no equivalent retry: an uncaught `lock-held` error here
   * propagates out of `JobSupervisor.start()`, out of `entry.ts`'s
   * `main()`, into `main().catch(fatal)`, which calls `process.exit(1)` —
   * killing the brand-new supervisor process just milliseconds after it
   * was spawned, well before it ever starts the workload or the IPC
   * server. The job record is then left stuck in "starting" forever with
   * no live supervisor, which is exactly what intermittently produced
   * `supervisorPidForJob()` finding no matching process in the flaky test
   * (a genuine production bug, not a test-only timing issue: a real user
   * could just as easily lose their supervisor this way on a loaded
   * machine). The fix mirrors the coordinator's own established pattern: a
   * few short, bounded retries absorb this expected, brief (milliseconds)
   * cross-process contention; a lock that is still held after all retries
   * is a genuine problem and the error still propagates untouched.
   */
  private async updateJobRetryingOnLockHeld(patch: Partial<JobRecord>): Promise<void> {
    const attempts = 5;
    const delayMs = 30;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.repositories.jobs.update(this.jobId, patch);
        return;
      } catch (error) {
        if (!(error instanceof BackgroundJobError) || error.code !== "lock-held") throw error;
        lastError = error;
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  private async publishSpawnFailure(error: Error): Promise<void> {
    await this.updateJob({
      state: "failed",
      exitCode: null,
      signal: null,
      endedAt: new Date().toISOString(),
    });
    const job = await this.repositories.jobs.get(this.jobId);
    this.resolveTerminalWaiters(job);
    void error; // message already implicit in the confirmed "failed" state; nothing else to attach it to here.
  }

  private async handleChildExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const dir = logsDir(this.root, this.jobId);

    // Determine outcome. Per solution.md §6: a normal exit (code !== null)
    // is a legitimate completion even if a stop was in flight, UNLESS the
    // exit signal matches the signal our own stop logic sent (in which case
    // it is an interrupted/stop-induced termination).
    let outcome: "completed" | "failed" | "interrupted";
    if (process.platform === "win32" && this.child?.killed && code === 1) {
      // Node's Windows TerminateProcess uses exit code 1, not an exit signal.
      outcome = "interrupted";
    } else if (code !== null) {
      outcome = code === 0 ? "completed" : "failed";
    } else if (signal !== null && signal === this.stopSignalSent) {
      outcome = "interrupted";
    } else if (this.stopRequested) {
      outcome = "interrupted";
    } else {
      // Killed by an external signal we did not request: still a confirmed,
      // known terminal event; report as failed (abnormal exit) rather than
      // uncertain, matching JobRecord.state's "failed" meaning ("confirmed
      // abnormal exit, exit code/signal known").
      outcome = "failed";
    }

    // Stream close does not await asynchronous persistence of the final chunks.
    await this.logWriteChain;
    if (process.platform === "win32" && this.shellWorkload && this.child?.killed) {
      await this.updateJob({ state: "unknown", exitCode: code, signal,
        uncertaintyReason: "Forced termination of the retained Windows child only; descendant termination is unverified (no Job Object)." });
      if (this.logWriter) {
        const writer = this.logWriter;
        await this.boundedLogOperation(() => writer.close(), writer).catch(() => {});
      }
      const job = await this.repositories.jobs.get(this.jobId);
      this.resolveTerminalWaiters(job);
      return;
    }
    let excerpt = { stdoutExcerpt: "", stderrExcerpt: this.loggingFailure ?? "", truncated: Boolean(this.loggingFailure) };
    if (!this.loggingFailure && this.logWriter) {
      const writer = this.logWriter;
      try {
        await this.boundedLogOperation(async () => {
          const captured = await buildCompletionExcerpt(dir, { maxExcerptBytes: COMPLETION_EXCERPT_BYTES, outcome });
          // A late read must not replace the published failure diagnostic.
          if (!this.loggingFailure) excerpt = captured;
        }, writer);
      } catch {
        excerpt = { stdoutExcerpt: "", stderrExcerpt: this.loggingFailure ?? "logging failure; output discarded", truncated: true };
      }
    }

    const eventId = randomUUID();
    const event: CompletionEventRecord = {
      eventId,
      jobId: this.jobId,
      outcome,
      exitCode: code,
      signal,
      stdoutExcerpt: excerpt.stdoutExcerpt,
      stderrExcerpt: excerpt.stderrExcerpt,
      truncated: excerpt.truncated,
      createdAt: new Date().toISOString(),
    };
    await this.repositories.events.create(event);

    // Publish the observed terminal result and stable completion-event ID
    // together, in one atomic update (solution.md §10).
    await this.updateJob({
      state: outcome,
      exitCode: code,
      signal,
      endedAt: new Date().toISOString(),
      resultEventId: eventId,
    });

    if (this.logWriter) {
      const writer = this.logWriter;
      await this.boundedLogOperation(() => writer.close(), writer).catch(() => {});
    }

    const job = await this.repositories.jobs.get(this.jobId);
    this.resolveTerminalWaiters(job);
  }

  private resolveTerminalWaiters(job: JobRecord | undefined): void {
    this.terminalJob = job;
    const waiters = this.terminalWaiters.splice(0, this.terminalWaiters.length);
    for (const resolve of waiters) resolve(job);
    // Fix A: the job has just reached a terminal lifecycle state (this
    // method is only ever called from `handleChildExit`/`publishSpawnFailure`,
    // the two places that happens). Start the idle-exit timer now — never
    // earlier, so a running/starting/accepted job's supervisor can never
    // self-exit while its workload might still be running or its
    // stop-control sequence might still be in flight.
    if (job && isTerminalLifecycle(job.state)) this.startIdleExitTimerIfNeeded();
  }

  /**
   * Fix A — automatic idle self-exit. Started once (idempotent) as soon as
   * the job goes terminal. Uses a periodic re-check (rather than a single
   * `setTimeout` fired once) so a client actively polling/reading logs right
   * up to the edge of the window keeps resetting the effective deadline —
   * see `lastActivityAt`, updated at the top of `handleIpcRequest`.
   */
  private startIdleExitTimerIfNeeded(): void {
    if (this.idleExitInterval !== undefined) return; // already running
    const interval = setInterval(() => {
      void this.checkIdleExit().catch(error => console.error("background job supervisor idle exit failed:", error));
    }, this.idleExitCheckIntervalMs);
    // Never let this timer keep a host process (notably the vitest worker
    // running this unit test suite) alive past its own natural exit. The
    // REAL supervisor process's actual reason to stay alive in the meantime
    // is its open IpcServer socket (and, while running, the workload's own
    // child handle) — not this bookkeeping timer — so `.unref()` is correct
    // and safe there too.
    interval.unref();
    this.idleExitInterval = interval;
  }

  private stopIdleExitTimer(): void {
    if (this.idleExitInterval !== undefined) {
      clearInterval(this.idleExitInterval);
      this.idleExitInterval = undefined;
    }
  }

  /**
   * Checked every `IDLE_EXIT_CHECK_INTERVAL_MS` once the job is terminal. If
   * `idleExitMs` has elapsed with no IPC activity AND no currently-connected
   * client, tears the supervisor down and exits the real OS process. Exposed
   * as a method (rather than inlined in the interval callback) so tests can
   * invoke it directly without waiting out the real interval.
   */
  private async checkIdleExit(): Promise<void> {
    const idleFor = Date.now() - this.lastActivityAt;
    if (idleFor < this.idleExitMs) return;
    const connectedClients = this.ipcServer?.listClients().length ?? 0;
    if (connectedClients > 0) return;

    this.stopIdleExitTimer();
    await this.teardown();
    // A real detached supervisor process has nothing else keeping its event
    // loop alive once the IPC server is stopped and the workload (already
    // terminal) is gone; `process.exit(0)` makes this self-exit explicit
    // and immediate rather than relying on that incidentally being true.
    process.exit(0);
  }

  /** Resolves once the job reaches a terminal lifecycle state. */
  private waitForTerminal(): Promise<JobRecord | undefined> {
    if (this.terminalJob !== undefined) return Promise.resolve(this.terminalJob);
    return new Promise((resolve) => {
      this.terminalWaiters.push(resolve);
    });
  }

  /**
   * Idempotent stop request. Manages ONLY `stopState` — never sets a
   * terminal lifecycle state itself (that remains the exclusive
   * responsibility of the child `exit` handler, per solution.md §6's
   * lifecycle-vs-stop-control separation).
   */
  async requestStop(_reason: string): Promise<void> {
    const current = await this.repositories.jobs.get(this.jobId);
    if (current && isTerminalLifecycle(current.state)) {
      // Already terminal: nothing to stop, and advancing stopState now
      // would be misleading. Idempotent no-op.
      return;
    }

    if (!this.stopRequested) {
      this.stopRequested = true;
      this.stopSignalSent = "SIGTERM";
      this.stopIntent = this.updateJob({ stopState: "requested" });
    }
    await this.stopIntent;
    await this.executeRequestedStop();
  }

  private executeRequestedStop(): Promise<void> {
    // Recording intent is not execution: startup will re-enter here after
    // publishing the retained live child. Only the execution is latched.
    if (!this.child || this.child.pid === undefined || !this.workloadPublished) return Promise.resolve();
    this.stopExecution ??= this.stopLiveChild();
    return this.stopExecution;
  }

  private async stopLiveChild(): Promise<void> {
    const child = this.child!;
    const ownershipHandle = String(child.pid);
    const adapter = await getPlatformAdapter();

    await this.updateJob({ stopState: "acknowledged" });

    // Windows fallback controls the retained live child handle, never a persisted
    // PID. It cannot stop descendants or provide graceful application shutdown.
    const outcome = process.platform === "win32"
      ? await this.stopWindowsChild(child)
      : await adapter.stopOwnedScope(ownershipHandle, this.workloadOwnershipScope, this.stopGraceMs);

    // If the child already exited naturally while stopOwnedScope was in
    // flight, the job may already be terminal by now; only advance
    // stopState, never touch lifecycle fields here. The `updateJob` chain
    // guarantees this update is applied after any terminal-state update
    // from `handleChildExit` that was already queued ahead of it.
    const afterStop = await this.repositories.jobs.get(this.jobId);
    if (process.platform === "win32" && this.shellWorkload && child.killed && outcome.observedStopped) {
      await this.updateJob({ state: "unknown", stopState: "acknowledged",
        uncertaintyReason: outcome.limitations.join(" ") });
      return;
    }
    if (afterStop && isTerminalLifecycle(afterStop.state)) {
      if (afterStop.state === "completed") {
        await this.updateJob({ stopState: "observed-completed-first" });
      } else if (outcome.observedStopped) {
        await this.updateJob({ stopState: "observed-stopped" });
      }
      return;
    }

    if (outcome.observedStopped) {
      await this.updateJob({ stopState: outcome.escalated ? "escalated" : "observed-stopped" });
    } else if (outcome.escalated) {
      await this.updateJob({ stopState: "escalated" });
    }
  }

  private async stopWindowsChild(child: WorkloadChild) {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (!exited()) child.kill();
    const deadline = Date.now() + this.stopGraceMs;
    while (!exited() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return {
      observedStopped: exited(), escalated: false, verifiedNoDescendants: false,
      limitations: ["Forced termination of the retained Windows child only; no Job Object or descendant verification."],
    };
  }

  private async startIpcServer(): Promise<void> {
    const server = new IpcServer(this.socketPath, {
      onRequest: (msg, respond) => {
        void this.handleIpcRequest(msg, respond);
      },
    });
    await server.start();
    this.ipcServer = server;
  }

  private async handleIpcRequest(msg: unknown, respond: (reply: unknown) => void): Promise<void> {
    // Fix A: record any IPC activity so the idle-exit timer's deadline
    // keeps resetting while a client is actively polling/reading logs.
    this.lastActivityAt = Date.now();
    try {
      if (!msg || typeof msg !== "object") {
        respond({ type: "error", message: "malformed request" } satisfies ErrorResponse);
        return;
      }
      const type = (msg as Record<string, unknown>).type;

      if (type === "poll") {
        const job = await this.repositories.jobs.get(this.jobId);
        respond({ type: "poll", job } satisfies PollResponse);
        return;
      }

      if (type === "log") {
        const req = msg as { maxBytes?: number; cursor?: string; stream?: "stdout" | "stderr" };
        const dir = logsDir(this.root, this.jobId);
        const stream = req.stream ?? "stdout";
        if (req.cursor !== undefined || req.maxBytes === undefined) {
          const result = await readCursor(dir, stream, req.cursor, req.maxBytes);
          respond({ type: "log", text: result.text, truncated: result.truncated, cursor: result.cursor } satisfies LogResponse);
        } else {
          const result = await readTail(dir, stream, req.maxBytes);
          respond({ type: "log", text: result.text, truncated: result.truncated } satisfies LogResponse);
        }
        return;
      }

      if (type === "stop") {
        await this.requestStop("ipc stop request");
        const job = await this.repositories.jobs.get(this.jobId);
        respond({ type: "stop", job } satisfies StopResponse);
        return;
      }

      if (type === "wait") {
        const job = await this.waitForTerminal();
        respond({ type: "wait", job } satisfies WaitResponse);
        return;
      }

      respond({ type: "error", message: `unknown request type: ${String(type)}` } satisfies ErrorResponse);
    } catch (error) {
      respond({ type: "error", message: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
    }
  }

  /** Stop-control state accessor for tests; not part of the IPC wire contract. */
  async stopControlState(): Promise<StopControlState | undefined> {
    const job = await this.repositories.jobs.get(this.jobId);
    return job?.stopState;
  }

  /** Shared teardown steps used by both `shutdown()` (test/cleanup helper) and Fix A's self-exit path. */
  private async teardown(): Promise<void> {
    // Drain any job-record update still in flight (e.g. a `close`/terminal
    // update queued just before shutdown was requested) before tearing down
    // resources, so callers (notably tests removing their temp directory
    // right after `shutdown()` resolves) never race an in-progress atomic
    // write against filesystem cleanup.
    await Promise.all([...this.backgroundTasks]);
    await this.finalization?.catch(() => {});
    await this.logWriteChain;
    // Resuming the final paused stream may only now deliver child's close.
    if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) {
      if (!this.finalization) await new Promise<void>(resolve => this.child!.once("close", () => resolve()));
      await this.finalization?.catch(() => {});
    }
    await this.updateChain.catch(() => {});
    if (this.ipcServer) {
      await this.ipcServer.stop().catch(() => {});
    }
    if (this.logWriter) {
      await this.logWriter.close().catch(() => {});
    }
  }

  /**
   * Test/cleanup helper: stops the IPC server and closes the log writer. A
   * real detached supervisor process never calls this directly during
   * normal operation — it lets the Node process exit naturally once the job
   * reaches a terminal state and the IPC server has served any final
   * requests (there is no parent to track; the supervisor decides its own
   * lifetime) — see `SUPERVISOR_IDLE_EXIT_MS`/`checkIdleExit` for the bound
   * on that lifetime (Fix A). Also clears the idle-exit interval (if
   * running) so tests calling `shutdown()` directly don't leave a dangling
   * timer behind (vitest "no open handles" hygiene) — the interval is
   * already `.unref()`'d so this is not strictly required for that purpose,
   * but is still correct/explicit cleanup for a supervisor instance that
   * will not be used again.
   */
  async shutdown(): Promise<void> {
    this.stopIdleExitTimer();
    await this.teardown();
  }
}
