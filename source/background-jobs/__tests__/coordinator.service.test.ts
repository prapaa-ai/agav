/**
 * T14 — End-to-end `CoordinatorClient` tests.
 *
 * IMPORTANT — build prerequisite: these tests launch REAL detached
 * supervisor processes through `coordinator/launcher.ts`, which resolves
 * the supervisor entry via `packaging/locator.ts#resolveSupervisorEntryPath()`
 * — a path computed relative to *that module's own compiled location on
 * disk* (`import.meta.url`). Under plain `vitest run`, TypeScript sources
 * are transpiled in place from `source/` (see vitest.config.ts — there is
 * no build-output redirect), so `import.meta.url` inside `locator.ts`
 * resolves to `source/background-jobs/packaging/locator.ts`'s own path and
 * the sibling lookup becomes `source/background-jobs/supervisor/entry.js`
 * — which never exists (only `entry.ts` lives in `source/`; the compiled
 * `.js` sibling only exists under `build/` after a real `tsc` run).
 *
 * To exercise the REAL end-to-end launch path (the whole point of this
 * file) this test therefore imports the coordinator from the COMPILED
 * `build/background-jobs/...` output rather than from `../coordinator/*.ts`,
 * so every module in the import graph (including `packaging/locator.js`)
 * resolves `import.meta.url` against `build/`, where `tsc` has placed the
 * real `supervisor/entry.js` right where `locator.ts` expects it. This
 * means a full build MUST be run first:
 *
 *   npx tsc -p tsconfig.json     (a full build, not --noEmit)
 *
 * from the repo root. Every type imported here (`BackgroundJobError`,
 * `DEFAULT_RESOURCE_LIMITS`, etc.) is likewise imported from the same
 * compiled `build/background-jobs/types.js` module as the coordinator uses
 * internally, so `instanceof`/structural checks compare against the exact
 * same class/values the coordinator throws/returns — importing the same
 * types from `../types.js` (the `.ts` source) would be a DIFFERENT module
 * instance under Node's module cache and would break `instanceof`.
 *
 * All processes spawned here are real `/bin/sh` child processes owned by
 * real detached supervisor processes. Every long-running job started in a
 * test is explicitly stopped in that test (or in `afterEach`) so no `sleep`
 * processes are left running once the suite exits.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Test-only cleanup helper: find and SIGKILL any `node .../supervisor/entry.js
 * <jobId> ...` process whose first argv after the script path matches one of
 * `jobIds` (see supervisor/entry.ts's argv contract: `<jobId> <requestId>
 * <root> <socketPath>`). This is scoped to jobIds this test itself created,
 * so it never risks touching an unrelated process.
 */
async function killSupervisorProcessesByJobIds(jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,args"]);
    for (const line of stdout.split("\n")) {
      if (!line.includes("supervisor/entry.js")) continue;
      const match = jobIds.find((id) => line.includes(id));
      if (!match) continue;
      const pidMatch = /^\s*(\d+)/.exec(line);
      if (!pidMatch) continue;
      const pid = Number(pidMatch[1]);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  } catch {
    // `ps` unavailable or no matches; nothing more to do (best-effort only).
  }
}

// NOTE: intentionally importing compiled build output at runtime, not
// `../coordinator/*.ts` (source) — see module doc above for why. The import
// specifier is deliberately computed at runtime (via `new URL(...)` +
// dynamic `import()`) rather than a static `import ... from "../../../build/..."`
// literal: a static specifier pointing into `build/` makes `tsc -p
// tsconfig.json` treat that directory's `.d.ts` files as program inputs
// (because `moduleResolution: nodenext` resolves the specifier to the
// adjacent declaration file), which then collides with `tsc`'s own
// declaration-emission for those exact files ("Cannot write file ... because
// it would overwrite input file", TS5055) on every subsequent build. A
// dynamic, non-literal `import()` call is never resolved/type-checked by
// `tsc` at compile time, so it cannot be pulled into the program's root file
// set. Only TYPES are imported statically from `../types.js` (the ordinary
// source import every other file in this subsystem uses) purely for
// structural typing in this test file (e.g. the `Coordinator` return type
// annotation) — those static type-only imports do not affect runtime
// module identity, since `type`-only imports are fully erased.
import type { Coordinator } from "../coordinator/service.js";
import type { SessionPolicySnapshot, StartJobRequest } from "../types.js";

async function importBuiltCoordinatorModule(): Promise<{ createCoordinator: typeof import("../coordinator/service.js").createCoordinator }> {
  const url = new URL("../../../build/background-jobs/coordinator/service.js", import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

async function importBuiltTypesModule(): Promise<typeof import("../types.js")> {
  const url = new URL("../../../build/background-jobs/types.js", import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

const { createCoordinator } = await importBuiltCoordinatorModule();
const { BackgroundJobError, DEFAULT_RESOURCE_LIMITS } = await importBuiltTypesModule();

let base: string;
let coordinator: Coordinator;
/** jobIds started in the current test that must be stopped during afterEach cleanup. */
let jobsToCleanUp: string[] = [];

const autoAccept: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };
const denyWrites: SessionPolicySnapshot = { permissionMode: "deny-writes", headlessApprovedActions: [] };

function baseRequest(overrides: Partial<StartJobRequest> = {}): StartJobRequest {
  return {
    requestId: randomUUID(),
    invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "echo hello && sleep 0.2 && echo done"] },
    cwd: "/tmp",
    isolation: { backend: "none", required: false },
    ...overrides,
  };
}

async function pollUntil(
  predicate: (summary: Awaited<ReturnType<Coordinator["poll"]>>) => boolean,
  jobId: string,
  timeoutMs = 20000,
  intervalMs = 150,
): Promise<Awaited<ReturnType<Coordinator["poll"]>>> {
  const deadline = Date.now() + timeoutMs;
  let last = await coordinator.poll(jobId);
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await coordinator.poll(jobId);
  }
  return last;
}

function isTerminal(summary: { state: string }): boolean {
  return summary.state === "completed" || summary.state === "failed" || summary.state === "interrupted";
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-bg-coordinator-test-"));
  coordinator = await createCoordinator({ root: base });
  jobsToCleanUp = [];
});

afterEach(async () => {
  // Best-effort: stop every job this test started that might still be
  // running, so no orphaned WORKLOAD (`sleep`/`sh`) processes survive the
  // test run — stop() terminates the workload's owned process group via the
  // real platform adapter.
  for (const jobId of jobsToCleanUp) {
    try {
      const summary = await coordinator.poll(jobId);
      if (!isTerminal(summary)) {
        await coordinator.stop(jobId, autoAccept);
      }
    } catch {
      // Job may already be gone/unknown; nothing more we can safely do.
    }
  }

  // Additional hygiene (beyond the stated "no orphaned sleep processes"
  // requirement): per T11's documented design, a supervisor process itself
  // deliberately ignores SIGTERM/SIGINT and keeps its IPC server listening
  // indefinitely even after its job reaches a terminal state — there is no
  // "supervisor self-exit" in this delivery. That is correct/intended
  // behavior (solution.md: "ordinary CLI/coordinator exit leaves work
  // running"), not a bug in this coordinator, but it does mean every test
  // here leaves one lightweight `node .../supervisor/entry.js` process
  // behind. `JobRecord.identity.pid` is the WORKLOAD's pid (see
  // supervisor/lifecycle.ts#start), not the supervisor's own pid — the
  // frozen `launchSupervisorForJob` signature returns `Promise<void>`, so
  // the supervisor's own pid is not available to this coordinator layer at
  // all. For test-only cleanup we instead find each test's own supervisor
  // process by matching its unique jobId argv token (the same value this
  // test itself generated and already knows), which is safe here because it
  // targets a value under this test's own control, not a historical/reused
  // pid.
  await killSupervisorProcessesByJobIds(jobsToCleanUp);

  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 30000);

describe("CoordinatorClient — capabilities", () => {
  it("resolves without throwing", async () => {
    const caps = await coordinator.capabilities();
    expect(caps.platform).toBe("linux");
    expect(Array.isArray(caps.limitations)).toBe(true);
  });
});

describe("CoordinatorClient — start/poll/log happy path", () => {
  it("returns a JobSummary quickly (non-blocking), then poll() eventually shows completed/exitCode 0, and log() contains output", async () => {
    const request = baseRequest();
    const startedAt = Date.now();
    const summary = await coordinator.start(request, autoAccept);
    const startDurationMs = Date.now() - startedAt;
    jobsToCleanUp.push(summary.jobId);

    // start() must not block until the job finishes (the test command sleeps
    // 0.2s then echoes "done"); a generous upper bound still proves it
    // returned long before the job's own ~0.2s+ runtime completed, since the
    // short poll window itself is capped at ~2s but typically resolves much
    // faster once the state moves off "accepted".
    expect(startDurationMs).toBeLessThan(5000);
    expect(["accepted", "starting", "running", "completed"]).toContain(summary.state);

    const final = await pollUntil((s) => s.state === "completed" || s.state === "failed", summary.jobId);
    expect(final.state).toBe("completed");
    expect(final.exitCode).toBe(0);

    const log = await coordinator.log(summary.jobId, { maxBytes: 65536 });
    expect(log.text).toContain("hello");
    expect(log.text).toContain("done");
  }, 20000);

  it("a command that exits 7 eventually shows failed with exitCode 7", async () => {
    const request = baseRequest({ invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "exit 7"] } });
    const summary = await coordinator.start(request, autoAccept);
    jobsToCleanUp.push(summary.jobId);

    const final = await pollUntil((s) => s.state === "completed" || s.state === "failed", summary.jobId);
    expect(final.state).toBe("failed");
    expect(final.exitCode).toBe(7);
  }, 20000);
});

describe("CoordinatorClient — idempotent retries and spec-changed", () => {
  it("calling start() twice with the identical requestId+spec returns the same jobId and does not spawn a second supervisor", async () => {
    const request = baseRequest({
      invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "sleep 1 && echo once"] },
    });

    const first = await coordinator.start(request, autoAccept);
    jobsToCleanUp.push(first.jobId);
    const second = await coordinator.start(request, autoAccept);

    expect(second.jobId).toBe(first.jobId);

    const all = await coordinator.list();
    const matching = all.filter((j) => j.requestId === request.requestId);
    expect(matching.length).toBe(1);
  }, 20000);

  it("reusing a requestId with a different spec throws BackgroundJobError('spec-changed')", async () => {
    const requestId = randomUUID();
    const first = baseRequest({ requestId, invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "sleep 1"] } });
    const firstSummary = await coordinator.start(first, autoAccept);
    jobsToCleanUp.push(firstSummary.jobId);

    const second = baseRequest({ requestId, invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "sleep 2"] } });

    await expect(coordinator.start(second, autoAccept)).rejects.toMatchObject({
      code: "spec-changed",
    });
    try {
      await coordinator.start(second, autoAccept);
      expect.unreachable("expected start() to throw for a changed spec");
    } catch (err) {
      expect(err).toBeInstanceOf(BackgroundJobError);
      expect((err as { code: string }).code).toBe("spec-changed");
    }
  }, 20000);
});

describe("CoordinatorClient — authorization", () => {
  it("start() under deny-writes throws BackgroundJobError('authorization-denied')", async () => {
    const request = baseRequest();
    await expect(coordinator.start(request, denyWrites)).rejects.toMatchObject({
      code: "authorization-denied",
    });
  });
});

describe("CoordinatorClient — wait cancellation", () => {
  it("wait() with an AbortSignal aborted shortly after resolves promptly with a non-terminal state, and the job keeps running", async () => {
    const request = baseRequest({ invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "sleep 30"] } });
    const summary = await coordinator.start(request, autoAccept);
    jobsToCleanUp.push(summary.jobId);

    await pollUntil((s) => s.state === "running", summary.jobId);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const waitStart = Date.now();
    const waitResult = await coordinator.wait(summary.jobId, controller.signal);
    const waitDurationMs = Date.now() - waitStart;

    // Must return promptly — nowhere near the full 30s sleep.
    expect(waitDurationMs).toBeLessThan(10000);
    expect(waitResult.state).not.toBe("completed");
    expect(waitResult.state).not.toBe("failed");

    // Confirm cancellation did not stop the job: a direct poll() still shows
    // it alive (not terminal).
    const stillRunning = await coordinator.poll(summary.jobId);
    expect(["running", "starting", "accepted"]).toContain(stillRunning.state);

    // Explicit cleanup for this long-running job (also covered by afterEach,
    // but stopping here keeps the test's own process footprint obvious).
    await coordinator.stop(summary.jobId, autoAccept);
    const final = await pollUntil((s) => isTerminal(s), summary.jobId);
    expect(final.state).toBe("interrupted");
  }, 30000);
});

describe("CoordinatorClient — stop", () => {
  it("stop() on a long-running job under auto-accept eventually results in interrupted", async () => {
    const request = baseRequest({ invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "sleep 30"] } });
    const summary = await coordinator.start(request, autoAccept);
    jobsToCleanUp.push(summary.jobId);

    await pollUntil((s) => s.state === "running", summary.jobId);

    const stopResult = await coordinator.stop(summary.jobId, autoAccept);
    expect(stopResult.stopState).not.toBe("none");

    const final = await pollUntil((s) => isTerminal(s), summary.jobId);
    expect(final.state).toBe("interrupted");
  }, 30000);
});

describe("CoordinatorClient — capacity", () => {
  it("returns BackgroundJobError('capacity-exceeded') once maxConcurrentJobs active jobs are running", async () => {
    const started: string[] = [];
    try {
      for (let i = 0; i < DEFAULT_RESOURCE_LIMITS.maxConcurrentJobs; i++) {
        const request = baseRequest({ invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "sleep 10"] } });
        const summary = await coordinator.start(request, autoAccept);
        started.push(summary.jobId);
        jobsToCleanUp.push(summary.jobId);
      }

      const overflowRequest = baseRequest({ invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "sleep 10"] } });
      await expect(coordinator.start(overflowRequest, autoAccept)).rejects.toMatchObject({
        code: "capacity-exceeded",
      });
    } finally {
      for (const jobId of started) {
        await coordinator.stop(jobId, autoAccept).catch(() => {});
      }
    }
  }, 30000);
});

describe("CoordinatorClient — cleanup", () => {
  it("refuses cleanup for a still-running job and succeeds for a terminal one", async () => {
    const runningRequest = baseRequest({ invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "sleep 30"] } });
    const runningSummary = await coordinator.start(runningRequest, autoAccept);
    jobsToCleanUp.push(runningSummary.jobId);
    await pollUntil((s) => s.state === "running", runningSummary.jobId);

    await expect(coordinator.cleanup(runningSummary.jobId, autoAccept)).rejects.toBeInstanceOf(BackgroundJobError);

    await coordinator.stop(runningSummary.jobId, autoAccept);
    await pollUntil((s) => isTerminal(s), runningSummary.jobId);

    const terminalRequest = baseRequest({ invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "exit 0"] } });
    const terminalSummary = await coordinator.start(terminalRequest, autoAccept);
    jobsToCleanUp.push(terminalSummary.jobId);
    await pollUntil((s) => isTerminal(s), terminalSummary.jobId);

    await expect(coordinator.cleanup(terminalSummary.jobId, autoAccept)).resolves.toBeUndefined();
  }, 30000);

  /**
   * Fix B — coordinator-driven reaping. `start()` must persist the
   * supervisor's OWN process identity/ownership onto the job record (not
   * just the workload's), and `cleanup()` on a terminal job must actually
   * terminate that supervisor OS process using the same cross-platform
   * `PlatformAdapter.stopOwnedScope` mechanism already used for workloads —
   * see `coordinator/launcher.ts` and `coordinator/service.ts`'s `start`/
   * `cleanup`. This uses the repo's own established
   * `ps -eo pid,args | grep supervisor/entry.js <jobId>` technique (see
   * `killSupervisorProcessesByJobIds` above) to directly observe the real
   * OS process, both to confirm it exists right after `start()` and that it
   * is GONE after `cleanup()`.
   */
  async function supervisorPidForJob(jobId: string): Promise<number | undefined> {
    try {
      const { stdout } = await execFileAsync("ps", ["-eo", "pid,args"]);
      for (const line of stdout.split("\n")) {
        if (!line.includes("supervisor/entry.js")) continue;
        if (!line.includes(jobId)) continue;
        const pidMatch = /^\s*(\d+)/.exec(line);
        if (pidMatch) return Number(pidMatch[1]);
      }
    } catch {
      // `ps` unavailable; best-effort only.
    }
    return undefined;
  }

  it("persists supervisorOwnershipHandle at start(), and cleanup() on a terminal job actually terminates the supervisor OS process", async () => {
    const request = baseRequest({ invocation: { mode: "direct", executable: "/bin/sh", args: ["-c", "exit 0"] } });
    const summary = await coordinator.start(request, autoAccept);
    jobsToCleanUp.push(summary.jobId);

    // Confirm Fix B's capture-and-persist step worked: the job record now
    // has a supervisorOwnershipHandle (distinct from the workload's own
    // `identity`/`ownershipHandle`).
    const persisted = await coordinator.repositories.jobs.get(summary.jobId);
    expect(persisted?.supervisorOwnershipHandle).toBeDefined();
    expect(persisted?.supervisorOwnershipScope).toBeDefined();
    expect(persisted?.supervisorIdentity?.pid).toBeDefined();

    // Confirm the supervisor process is actually alive before cleanup.
    await pollUntil((s) => isTerminal(s), summary.jobId);
    const pidBefore = await supervisorPidForJob(summary.jobId);
    expect(pidBefore).toBeDefined();

    await coordinator.cleanup(summary.jobId, autoAccept);

    // Give the (real, cross-platform) stopOwnedScope call a brief moment to
    // observe termination, mirroring how stop()/reconcile tests elsewhere in
    // this file poll rather than asserting instantaneously.
    const deadline = Date.now() + 10000;
    let pidAfter = await supervisorPidForJob(summary.jobId);
    while (pidAfter !== undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      pidAfter = await supervisorPidForJob(summary.jobId);
    }
    expect(pidAfter).toBeUndefined();
  }, 30000);
});
