/**
 * T11 — JobSupervisor tests.
 *
 * `JobSupervisor` is driven directly (not through `entry.ts`/a real
 * detached process, which would be too slow/flaky for unit tests). Each
 * test uses a real temp directory, a real `createFileRepositories`, and a
 * real `IpcServer`/`IpcClient` pair talking over a real Unix socket, with
 * real short-lived Node child processes as the workload.
 *
 * Because `JobSupervisor.start()` creates the IPC socket asynchronously
 * (after persisting the "starting" lifecycle state), tests connect via
 * `IpcClient.connectWithRetry` rather than a single `connect()` attempt to
 * avoid a startup race against socket-file creation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createFileRepositories } from "../storage/repositories.js";
import { resolveStorageRoot } from "../storage/paths.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { IpcClient } from "../ipc/client.js";
import { JobSupervisor } from "../supervisor/lifecycle.js";
import type { JobRecord, LaunchSpec, Repositories } from "../types.js";

let base: string;
let root: string;
let repositories: Repositories;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-bg-supervisor-test-"));
  root = await resolveStorageRoot(base);
  repositories = createFileRepositories(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeLaunchSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  const requestId = overrides.requestId ?? randomUUID();
  return {
    requestId,
    invocation: { mode: "direct", executable: process.execPath, args: ["-e", "console.log('hi'); setTimeout(() => console.log('done'), 200)"] },
    cwd: base,
    env: {},
    credentialRefs: [],
    isolation: { backend: "none", required: false },
    ownershipScope: process.platform === "win32" ? "unverified" : "process-group",
    limits: {
      logSegmentBytes: 1024 * 1024,
      retainedLogBytesPerJob: 10 * 1024 * 1024,
      aggregatePerUserLogBudgetBytes: 100 * 1024 * 1024,
      maxConcurrentJobs: 4,
      completedLogRetentionDays: 7,
    },
    headless: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function createAcceptedJob(requestId: string): Promise<string> {
  const jobId = randomUUID();
  const record: JobRecord = {
    jobId,
    requestId,
    specHash: "test-hash",
    protocolVersion: 1,
    state: "accepted",
    stopState: "none",
    nonce: randomUUID(),
  };
  await repositories.jobs.create(record);
  return jobId;
}

async function setup(
  spec: LaunchSpec,
  opts?: { idleExitMs?: number; idleExitCheckIntervalMs?: number },
): Promise<{ jobId: string; supervisor: JobSupervisor; socketPath: string }> {
  await repositories.specs.put(spec);
  const jobId = await createAcceptedJob(spec.requestId);
  const socketPath = getSocketPath(root, `job-${jobId}`);
  const supervisor = new JobSupervisor({
    jobId,
    requestId: spec.requestId,
    repositories,
    root,
    socketPath,
    stopGraceMs: 300,
    idleExitMs: opts?.idleExitMs,
    idleExitCheckIntervalMs: opts?.idleExitCheckIntervalMs,
  });
  return { jobId, supervisor, socketPath };
}

async function pollUntil(
  client: IpcClient,
  predicate: (job: JobRecord | undefined) => boolean,
  timeoutMs = 5000,
): Promise<JobRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: JobRecord | undefined;
  while (Date.now() < deadline) {
    const reply = (await client.request({ type: "poll" })) as { type: "poll"; job: JobRecord | undefined };
    last = reply.job;
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  return last;
}

/**
 * Runs `body` against a started supervisor + connected IPC client, with
 * guaranteed cleanup (client close, awaited start(), supervisor shutdown)
 * even if `body` throws or the connection attempt itself fails — this
 * avoids leaking a running child process / socket past the end of a test,
 * which previously caused flaky `ENOTEMPTY` races against `afterEach`'s
 * temp-dir removal.
 */
async function withRunningJob(
  spec: LaunchSpec,
  body: (ctx: { client: IpcClient; jobId: string; supervisor: JobSupervisor }) => Promise<void>,
): Promise<void> {
  const { supervisor, socketPath, jobId } = await setup(spec);
  const startPromise = supervisor.start(spec).catch(() => {});
  let client: IpcClient | undefined;
  try {
    client = await IpcClient.connectWithRetry(socketPath, { retries: 60, delayMs: 50, timeoutMs: 2000 });
    await body({ client, jobId, supervisor });
  } finally {
    if (client) await client.close().catch(() => {});
    await startPromise;
    await supervisor.shutdown().catch(() => {});
  }
}

describe("JobSupervisor", () => {
  it("runs a job to normal completion: poll transitions running -> completed, logs show output, completion event created", async () => {
    await withRunningJob(makeLaunchSpec(), async ({ client }) => {
      const running = await pollUntil(client, (j) => j?.state === "running" || j?.state === "completed");
      expect(running).toBeDefined();

      const final = await pollUntil(client, (j) => j?.state === "completed" || j?.state === "failed");
      expect(final?.state).toBe("completed");
      expect(final?.exitCode).toBe(0);
      expect(final?.resultEventId).toBeDefined();

      const event = await repositories.events.get(final!.resultEventId!);
      expect(event).toBeDefined();
      expect(event?.outcome).toBe("completed");

      const logReply = (await client.request({ type: "log", maxBytes: 65536 })) as {
        type: "log";
        text: string;
        truncated: boolean;
        cursor?: string;
      };
      expect(logReply.text).toContain("hi");
      expect(logReply.text).toContain("done");
    });
  }, 15000);

  it("reports a non-zero exit as 'failed' with the correct exit code", async () => {
    const spec = makeLaunchSpec({ invocation: { mode: "direct", executable: process.execPath, args: ["-e", "process.exit(7)"] } });
    await withRunningJob(spec, async ({ client }) => {
      const final = await pollUntil(client, (j) => j?.state === "completed" || j?.state === "failed");
      expect(final?.state).toBe("failed");
      expect(final?.exitCode).toBe(7);

      const event = await repositories.events.get(final!.resultEventId!);
      expect(event?.outcome).toBe("failed");
    });
  }, 15000);

  it("requestStop() on a long-running job progresses stop-control state and ends in 'interrupted'", async () => {
    const spec = makeLaunchSpec({ invocation: { mode: "direct", executable: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] } });
    await withRunningJob(spec, async ({ client }) => {
      await pollUntil(client, (j) => j?.state === "running");

      const stopReply = (await client.request({ type: "stop" })) as { type: "stop"; job: JobRecord | undefined };
      expect(stopReply.job?.stopState).not.toBe("none");

      const final = await pollUntil(client, (j) => j?.state === "interrupted" || j?.state === "completed" || j?.state === "failed");
      expect(final?.state).toBe("interrupted");
      expect(["acknowledged", "observed-stopped", "escalated"]).toContain(final?.stopState);
    });
  }, 15000);

  it("calling requestStop() twice does not error and does not conflict", async () => {
    const spec = makeLaunchSpec({ invocation: { mode: "direct", executable: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] } });
    await withRunningJob(spec, async ({ client }) => {
      await pollUntil(client, (j) => j?.state === "running");

      const [a, b] = await Promise.all([
        client.request({ type: "stop" }),
        client.request({ type: "stop" }),
      ]);
      expect((a as { type: string }).type).toBe("stop");
      expect((b as { type: string }).type).toBe("stop");

      const final = await pollUntil(client, (j) => j?.state === "interrupted" || j?.state === "completed" || j?.state === "failed");
      expect(final?.state).toBe("interrupted");
    });
  }, 15000);

  it("wait via IPC resolves once the job reaches a terminal state", async () => {
    const spec = makeLaunchSpec({ invocation: { mode: "direct", executable: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 300)"] } });
    await withRunningJob(spec, async ({ client }) => {
      const waitReply = (await client.request({ type: "wait" }, 10000)) as { type: "wait"; job: JobRecord | undefined };
      expect(waitReply.job?.state).toBe("completed");
    });
  }, 15000);

  it("natural completion racing an in-flight stop reports a truthful terminal outcome", async () => {
    const spec = makeLaunchSpec({ invocation: { mode: "direct", executable: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 50)"] } });
    await withRunningJob(spec, async ({ client }) => {
      await pollUntil(client, (j) => j?.state === "running");
      // Race: request stop at roughly the same time the process would
      // naturally exit. Exact timing cannot be deterministically forced, so
      // only assert a legitimate terminal outcome, not a specific one.
      await client.request({ type: "stop" }).catch(() => {});

      const final = await pollUntil(client, (j) => j?.state === "completed" || j?.state === "failed" || j?.state === "interrupted");
      expect(["completed", "interrupted"]).toContain(final?.state);
      expect(final?.state).not.toBe("unknown");
    });
  }, 15000);

  it("a spawn failure (invalid executable path) results in a 'failed' job record, not 'unknown'", async () => {
    const spec = makeLaunchSpec({
      invocation: { mode: "direct", executable: "/nonexistent/path/to/nothing", args: [] },
    });
    const { supervisor, jobId } = await setup(spec);
    await supervisor.start(spec);

    const job = await repositories.jobs.get(jobId);
    expect(job?.state).toBe("failed");
    expect(job?.exitCode).toBeNull();

    await supervisor.shutdown();
  }, 10000);

  it("shell-mode invocation is resolved via buildShellInvocation before spawning", async () => {
    const spec = makeLaunchSpec({ invocation: { mode: "shell", interpreter: process.platform === "win32" ? "cmd" : "posix-sh", commandText: "echo shell-mode-ok" } });
    await withRunningJob(spec, async ({ client }) => {
      const final = await pollUntil(client, (j) => j?.state === "completed" || j?.state === "failed");
      expect(final?.state).toBe("completed");
      const logReply = (await client.request({ type: "log", maxBytes: 65536 })) as { type: "log"; text: string };
      expect(logReply.text).toContain("shell-mode-ok");
    });
  }, 15000);
});

/**
 * Fix A — automatic idle self-exit.
 *
 * Approach for testing `process.exit(0)` without actually killing the test
 * runner: `vi.spyOn(process, "exit").mockImplementation(() => undefined as
 * never)`. This is option (a) from the task brief — it lets the real
 * production code path run unmodified (the idle-exit interval callback,
 * `checkIdleExit`, really does call `process.exit(0)`), while we assert
 * BOTH that `process.exit` was called with `0` AND that the real IPC server
 * was actually stopped as a side effect (a fresh `IpcClient.connect()`
 * attempt against the same socket path fails), which is the behaviorally
 * meaningful assertion — `process.exit` itself being a no-op under the spy
 * means the Node process-under-test keeps running afterward, so there is no
 * risk of the spy actually terminating the vitest worker.
 */
describe("JobSupervisor — Fix A: automatic idle self-exit", () => {
  it("self-exits (process.exit(0)) and stops its IPC server after idleExitMs of no activity once the job is terminal", async () => {
    const spec = makeLaunchSpec({ invocation: { mode: "direct", executable: process.execPath, args: ["-e", "process.exit(0)"] } });
    const { supervisor, socketPath, jobId } = await setup(spec, { idleExitMs: 200, idleExitCheckIntervalMs: 50 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      await supervisor.start(spec);

      // Let the job reach terminal state and then let idle time elapse with
      // no further IPC activity at all (no client connects after this).
      const deadline = Date.now() + 5000;
      let job = await repositories.jobs.get(jobId);
      while (job !== undefined && job.state !== "completed" && job.state !== "failed" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        job = await repositories.jobs.get(jobId);
      }
      expect(job?.state).toBe("completed");

      // Wait past idleExitMs + a couple of check intervals for the timer to
      // fire the self-exit path.
      await new Promise((r) => setTimeout(r, 600));

      expect(exitSpy).toHaveBeenCalledWith(0);

      // Confirm the IPC server was actually stopped as a real side effect
      // of the teardown path (not just that process.exit was invoked).
      await expect(
        IpcClient.connectWithRetry(socketPath, { retries: 1, delayMs: 50, timeoutMs: 500 }),
      ).rejects.toBeTruthy();
    } finally {
      exitSpy.mockRestore();
      await supervisor.shutdown().catch(() => {});
    }
  }, 15000);

  it("an actively-polling client prevents self-exit during the idle window", async () => {
    const spec = makeLaunchSpec({ invocation: { mode: "direct", executable: process.execPath, args: ["-e", "process.exit(0)"] } });
    const { supervisor, socketPath } = await setup(spec, { idleExitMs: 300, idleExitCheckIntervalMs: 50 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const startPromise = supervisor.start(spec).catch(() => {});
    let client: IpcClient | undefined;
    try {
      client = await IpcClient.connectWithRetry(socketPath, { retries: 60, delayMs: 50, timeoutMs: 2000 });
      await pollUntil(client, (j) => j?.state === "completed" || j?.state === "failed");

      // Keep polling at an interval shorter than idleExitMs for longer than
      // idleExitMs would otherwise allow, resetting the deadline each time.
      const activeUntil = Date.now() + 700;
      while (Date.now() < activeUntil) {
        await client.request({ type: "poll" });
        await new Promise((r) => setTimeout(r, 100));
      }

      // Self-exit must NOT have fired yet: activity kept resetting the
      // deadline throughout the window above.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      if (client) await client.close().catch(() => {});
      await startPromise;
      exitSpy.mockRestore();
      await supervisor.shutdown().catch(() => {});
    }
  }, 15000);
});
