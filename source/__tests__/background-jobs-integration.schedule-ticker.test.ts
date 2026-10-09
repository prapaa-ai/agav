/**
 * Tests for `startScheduleTicker` / `stopScheduleTicker`
 * (source/background-jobs-integration.ts) — the periodic driver that calls
 * `ScheduleEngine.evaluateOnce()` so a schedule created via `/process
 * schedule create` or the `run_background_job` tool's `schedule-create`
 * action actually triggers. Fixes Blocker 1: previously nothing called
 * `evaluateOnce()` at all.
 *
 * Fake-timers-vs-real-timers choice: fake timers (`vi.useFakeTimers()` +
 * `vi.advanceTimersByTimeAsync`) are used throughout. They proved perfectly
 * compatible with the ticker's `setInterval(() => { void (async () => {
 * ... })() }, intervalMs)` shape — `advanceTimersByTimeAsync` flushes
 * microtasks between fake-timer advances, so the awaited
 * `getSharedScheduleEngine()` / `evaluateOnce()` calls inside the interval
 * callback resolve normally before the next assertion runs. This keeps the
 * test deterministic and fast (no real 30s/50ms waits), matching the
 * project's existing precedent (see subagent-cancel.test.ts,
 * utils.session-picker-rename.test.ts for the same
 * useFakeTimers+advanceTimersByTimeAsync pattern elsewhere in this repo).
 *
 * Schedule-engine seam: rather than mocking the whole
 * `background-jobs-integration.js` module (impossible here since
 * `startScheduleTicker`/`stopScheduleTicker` themselves live in that exact
 * module, alongside `getSharedScheduleEngine`), a REAL coordinator +
 * real schedule engine is constructed over a temp directory — the same
 * "real coordinator from build/" pattern used by
 * tools.background-job-schedule.test.ts and commands.process-schedule.test.ts
 * — with ZERO schedules ever created, so each `evaluateOnce()` call is fast
 * (a single empty `repositories.schedules.list()` read) and side-effect
 * free. The real engine instance returned by `getSharedScheduleEngine()` is
 * then wrapped with `vi.spyOn(engine, "evaluateOnce")` so invocation count
 * and timing can be asserted directly, and (for the error-recovery test)
 * the spy's resolved/rejected behavior can be overridden for a single call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  startScheduleTicker,
  stopScheduleTicker,
  __resetScheduleTickerForTests,
  __setSharedCoordinatorForTests,
  __setSharedScheduleEngineForTests,
  getSharedScheduleEngine,
} = await import("../background-jobs-integration.js");

async function importBuiltCoordinatorModule(): Promise<typeof import("../background-jobs/coordinator/service.js")> {
  const url = new URL("../../build/background-jobs/coordinator/service.js", import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

let root: string;
let coordinator: Awaited<ReturnType<typeof import("../background-jobs/coordinator/service.js").createCoordinator>>;

const fakeSession = () => ({ permissionMode: "auto-accept" as const, headlessApprovedActions: [] });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-schedule-ticker-test-"));
  const { createCoordinator } = await importBuiltCoordinatorModule();
  coordinator = await createCoordinator({ root });
  __setSharedCoordinatorForTests(coordinator as any);
  vi.useFakeTimers();
});

afterEach(async () => {
  stopScheduleTicker();
  __resetScheduleTickerForTests();
  __setSharedScheduleEngineForTests(null);
  __setSharedCoordinatorForTests(null);
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 20000);

describe("startScheduleTicker / stopScheduleTicker", () => {
  it("calls evaluateOnce roughly every intervalMs after starting", async () => {
    const engine = await getSharedScheduleEngine();
    const spy = vi.spyOn(engine, "evaluateOnce");

    startScheduleTicker(fakeSession, 50);

    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledTimes(3);

    // Each call is passed a fresh nowUtc and the single synthesized
    // connected-session snapshot (no multi-client concept exists here).
    const lastArgs = spy.mock.calls.at(-1)![0];
    expect(lastArgs.connectedSessions).toEqual([{ permissionMode: "auto-accept", headlessApprovedActions: [] }]);
    expect(lastArgs.nowUtc).toBeInstanceOf(Date);
  });

  it("calling startScheduleTicker twice without stopping does not start a second concurrent interval", async () => {
    const engine = await getSharedScheduleEngine();
    const spy = vi.spyOn(engine, "evaluateOnce");

    startScheduleTicker(fakeSession, 50);
    startScheduleTicker(fakeSession, 50); // second call must be a no-op (guard)

    await vi.advanceTimersByTimeAsync(150);
    // With one interval at 50ms, 150ms of advance fires exactly 3 ticks.
    // If a second concurrent interval had been started, this would be 6.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("stopScheduleTicker stops future ticks", async () => {
    const engine = await getSharedScheduleEngine();
    const spy = vi.spyOn(engine, "evaluateOnce");

    startScheduleTicker(fakeSession, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledTimes(1);

    stopScheduleTicker();
    await vi.advanceTimersByTimeAsync(200);
    expect(spy).toHaveBeenCalledTimes(1); // no further ticks after stop
  });

  it("a thrown/rejected evaluateOnce on one tick does not prevent subsequent ticks from running", async () => {
    const engine = await getSharedScheduleEngine();
    const spy = vi.spyOn(engine, "evaluateOnce");
    spy.mockRejectedValueOnce(new Error("simulated evaluateOnce failure"));

    startScheduleTicker(fakeSession, 50);

    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledTimes(1); // the failing call

    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledTimes(2); // ticker kept going after the rejection
  });

  it("stopScheduleTicker is safe to call when not running", () => {
    expect(() => stopScheduleTicker()).not.toThrow();
  });
});
