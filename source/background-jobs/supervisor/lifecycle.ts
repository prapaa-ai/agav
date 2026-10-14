// Orchestration core for one background job, constructible without a detached process (for tests).
// Lifecycle (JobRecord.state) and stop-control (stopState) are kept separate: only the child's
// close handler sets a terminal lifecycle state; only requestStop advances stopState.
//
// Known limitations:
//   - `identity.creationIdentity` is just `String(pid)`; the supervisor holds the child handle so
//     PID reuse can't confuse it, but external observers re-verifying after a supervisor crash get
//     only a weak identity.
//   - IPC `wait` has no server-side cancellation message; a client cancels by closing its connection.
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { join } from "node:path";

type WorkloadChild = ChildProcessByStdio<null, Readable, Readable>;

import type {
  CompletionEventRecord,
  JobRecord,
  LaunchSpec,
  Repositories,
  StopControlState,
} from "../types.js";
import { BackgroundJobError, isTerminalLifecycle } from "../types.js";
import { getPlatformAdapter, ownedScopeHasLiveMembers } from "../platform/index.js";
import { buildShellInvocation } from "../launch-spec/shell.js";
import { SegmentedLogWriter } from "../logging/segment-writer.js";
import { buildCompletionExcerpt, readCursor, readTail } from "../logging/segment-reader.js";
import { describeLoggingFailureAction } from "../logging/failure-policy.js";
import { IpcServer } from "../ipc/server.js";

/** Grace period between SIGTERM and SIGKILL escalation. */
export const DEFAULT_STOP_GRACE_MS = 5000;

/**
 * Once the job is terminal, the supervisor self-exits after this much idle time (no IPC
 * activity and no connected client), so it can't leak forever. Never applies before the
 * job is terminal.
 */
export const SUPERVISOR_IDLE_EXIT_MS = 5 * 60 * 1000;

const IDLE_EXIT_CHECK_INTERVAL_MS = 30 * 1000;

const OWNED_SCOPE_POLL_INTERVAL_MS = 500;

const COMPLETION_EXCERPT_BYTES = 8 * 1024;

export interface JobSupervisorOptions {
  jobId: string;
  requestId: string;
  repositories: Repositories;
  root: string;
  socketPath: string;
  stopGraceMs?: number;
  /** Maximum duration of one log operation before retiring the writer. */
  logOperationTimeoutMs?: number;
  idleExitMs?: number;
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
  /** Set by teardown so a pending owned-scope drain wait gives up without publishing. */
  private scopeWaitCancelled = false;
  /** Wakes the pending owned-scope poll sleep early (teardown only). */
  private cancelScopeWaitSleep: (() => void) | undefined;
  /** Owned scope still had live members after the direct child exited. */
  private scopeSurvivedChildExit = false;
  /** A stop terminated descendants that outlived the direct child. */
  private stopInterruptedSurvivors = false;
  /** Resolves once finalization starts waiting for surviving descendants. */
  private markScopeDrainPending: () => void = () => {};
  private readonly scopeDrainPending: Promise<void> = new Promise<void>((resolve) => {
    this.markScopeDrainPending = resolve;
  });

  private readonly terminalWaiters: Array<(job: JobRecord | undefined) => void> = [];
  private terminalJob: JobRecord | undefined;

  private lastActivityAt: number = Date.now();
  private idleExitInterval: NodeJS.Timeout | undefined;

  // The job lock throws on contention instead of queueing, so this instance's updates
  // (e.g. requestStop vs. the child close handler) are serialized to avoid spurious
  // `lock-held`. Cross-process contention is handled by updateJobRetryingOnLockHeld.
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
   * Never throws for a confirmed spawn failure (it is published as "failed"); throws only
   * for caller bugs (missing job record) or storage failures that prevent any observation.
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

    // Start early so pollers can observe "starting" before the workload spawns.
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
          // Fire-and-forget: this callback must not throw.
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
      // Synchronous throw: same as an async spawn error, a confirmed failure.
      await this.publishSpawnFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // Listeners (and the stdio drains below) must be attached synchronously after spawn(),
    // before any `await`: a fast child can emit 'close' on the next tick and EventEmitter
    // doesn't replay. Terminal events are captured here and processed once "running" is persisted.
    let earlySpawnError: Error | undefined;
    let earlyClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let sawSpawn = false;
    let publishedRunning = false;
    child.on("error", (err) => {
      if (!sawSpawn && earlyClose === undefined) {
        earlySpawnError = err instanceof Error ? err : new Error(String(err));
      }
      // A late 'error' after "running" is not a lifecycle event; `close` is the source of truth.
    });
    child.once("spawn", () => {
      sawSpawn = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      child.stdout.pause();
      this.queueLogWrite(writer, "stdout", chunk, child.stdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      child.stderr.pause();
      this.queueLogWrite(writer, "stderr", chunk, child.stderr);
    });
    // 'close', not 'exit': 'exit' can fire before buffered output is delivered, racing the
    // completion excerpt against unflushed log writes.
    child.on("close", (code, signal) => {
      earlyClose = { code, signal };
      if (publishedRunning) this.runBackground(this.finalizeChild(code, signal));
    });

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
        creationIdentity: isWindows ? "unavailable" : String(child.pid),
      },
      ownershipHandle: String(child.pid),
      ownershipScope: this.workloadOwnershipScope,
      startedAt: new Date().toISOString(),
    });

    publishedRunning = true;
    this.workloadPublished = true;
    if (earlyClose) {
      // If descendants survive the direct child, finalization keeps waiting; start() must
      // not block on that (stop/poll must stay serviceable), so it continues in the background.
      const finalization = this.finalizeChild(earlyClose.code, earlyClose.signal);
      finalization.catch(() => {});
      const settled = await Promise.race([
        finalization.then(() => true),
        this.scopeDrainPending.then(() => false),
      ]);
      if (!settled) this.runBackground(finalization);
      else await finalization;
    }
    if (this.stopRequested) await this.executeRequestedStop();

    // Fast close events are deferred until running is persisted; serialization
    // cannot correct a terminal update queued before the running update.
  }

  /** Own detached callbacks so teardown cannot race their durable publication. */
  private runBackground(task: Promise<void>): void {
    const handled = task.catch(error => {
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
      // Pending I/O isn't cancellable: close the writer only after it settles, never
      // concurrently with append/rotation.
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

  private updateJob(patch: Partial<JobRecord>): Promise<void> {
    const next = this.updateChain.then(() => this.updateJobRetryingOnLockHeld(patch));
    // A failed update must not poison the chain; callers still see it via `next`.
    this.updateChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // The coordinator persists supervisor identity onto the same job record at about the time
  // this process makes its first update; the lock throws on cross-process contention, which
  // would otherwise kill the new supervisor and leave the job stuck in "starting". A few short
  // retries absorb that; a lock still held afterwards is a real problem and propagates.
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
    void error; // nothing to attach the message to
  }

  /**
   * The direct child exiting doesn't mean the owned group finished (`sleep 300 & exit 0`
   * leaves a descendant). While members survive the job stays non-terminal and stop still
   * works (it signals the whole group via the adapter). Resolves true once the group is
   * empty or the probe is inconclusive/unsupported (prior direct-child-only behaviour),
   * false if torn down first.
   */
  private async waitForOwnedScopeToDrain(): Promise<boolean> {
    const pid = this.child?.pid;
    if (pid === undefined) return true;
    const handle = String(pid);
    const alive = async (): Promise<boolean> => {
      try {
        return await ownedScopeHasLiveMembers(handle, this.workloadOwnershipScope);
      } catch {
        return false; // inconclusive probe: fall back to prior behaviour
      }
    };
    if (!(await alive())) return true;
    this.scopeSurvivedChildExit = true;
    this.markScopeDrainPending();
    for (;;) {
      // On teardown, one last probe: if the group has just emptied, still
      // publish the terminal state; only give up when members really survive.
      if (this.scopeWaitCancelled) return !(await alive());
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.cancelScopeWaitSleep = undefined;
          resolve();
        }, OWNED_SCOPE_POLL_INTERVAL_MS);
        timer.unref();
        this.cancelScopeWaitSleep = () => {
          clearTimeout(timer);
          this.cancelScopeWaitSleep = undefined;
          resolve();
        };
      });
      if (!(await alive())) return true;
      if (this.scopeWaitCancelled) return false;
    }
  }

  private async handleChildExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const dir = logsDir(this.root, this.jobId);

    if (!(await this.waitForOwnedScopeToDrain())) return;
    // The drain may have been won by a stop that is still recording its outcome.
    if (this.scopeSurvivedChildExit && this.stopRequested) await this.executeRequestedStop().catch(() => {});

    // A normal exit is a completion even if a stop was in flight, unless the exit signal
    // is the one our own stop sent (then it is interrupted).
    let outcome: "completed" | "failed" | "interrupted";
    if (process.platform === "win32" && this.child?.killed && code === 1) {
      // Node's Windows TerminateProcess uses exit code 1, not an exit signal.
      outcome = "interrupted";
    } else if (this.stopInterruptedSurvivors) {
      outcome = "interrupted";
    } else if (code !== null) {
      outcome = code === 0 ? "completed" : "failed";
    } else if (signal !== null && signal === this.stopSignalSent) {
      outcome = "interrupted";
    } else if (this.stopRequested) {
      outcome = "interrupted";
    } else {
      // Killed by an external signal we didn't request: confirmed abnormal exit.
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

    // Result and completion-event ID are published in one atomic update.
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
    if (job && isTerminalLifecycle(job.state)) this.startIdleExitTimerIfNeeded();
  }

  // Periodic re-check rather than one setTimeout, so a client polling near the end of the
  // window keeps pushing the deadline out (`lastActivityAt`).
  private startIdleExitTimerIfNeeded(): void {
    if (this.idleExitInterval !== undefined) return; // already running
    const interval = setInterval(() => {
      void this.checkIdleExit().catch(error => console.error("background job supervisor idle exit failed:", error));
    }, this.idleExitCheckIntervalMs);
    // Unref'd: the IPC socket, not this timer, keeps the real supervisor alive.
    interval.unref();
    this.idleExitInterval = interval;
  }

  private stopIdleExitTimer(): void {
    if (this.idleExitInterval !== undefined) {
      clearInterval(this.idleExitInterval);
      this.idleExitInterval = undefined;
    }
  }

  /** Tears down and exits once idle past `idleExitMs` with no connected client. Separate method so tests can call it directly. */
  private async checkIdleExit(): Promise<void> {
    const idleFor = Date.now() - this.lastActivityAt;
    if (idleFor < this.idleExitMs) return;
    const connectedClients = this.ipcServer?.listClients().length ?? 0;
    if (connectedClients > 0) return;

    this.stopIdleExitTimer();
    await this.teardown();
    process.exit(0);
  }

  private waitForTerminal(): Promise<JobRecord | undefined> {
    if (this.terminalJob !== undefined) return Promise.resolve(this.terminalJob);
    return new Promise((resolve) => {
      this.terminalWaiters.push(resolve);
    });
  }

  /** Idempotent. Manages only `stopState`; never sets a terminal lifecycle state. */
  async requestStop(_reason: string): Promise<void> {
    const current = await this.repositories.jobs.get(this.jobId);
    if (current && isTerminalLifecycle(current.state)) {
      // Already terminal: advancing stopState now would be misleading.
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

    if (outcome.observedStopped && this.scopeSurvivedChildExit) this.stopInterruptedSurvivors = true;

    // The child may have exited naturally while stopOwnedScope was in flight: only advance
    // stopState here, never lifecycle fields.
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

  private async teardown(): Promise<void> {
    // A pending wait for surviving descendants must not block teardown; the
    // job simply stays non-terminal on disk (recovery reconciles it).
    this.scopeWaitCancelled = true;
    this.cancelScopeWaitSleep?.();
    // Drain in-flight job-record updates so callers never race an atomic write against cleanup.
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

  /** Test/cleanup helper; a real supervisor exits via `checkIdleExit`. */
  async shutdown(): Promise<void> {
    this.stopIdleExitTimer();
    await this.teardown();
  }
}
