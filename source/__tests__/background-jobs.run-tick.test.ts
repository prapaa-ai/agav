/**
 * WP-08 / plan item 1.1 — `runBackgroundTick`, the shared one-tick driver
 * used by the interactive schedule ticker and the headless tick entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runBackgroundTick,
  startScheduleTicker,
  stopScheduleTicker,
  __resetScheduleTickerForTests,
  __resetStartupReconcileForTests,
  __setSharedScheduleEngineForTests,
} = await import("../background-jobs-integration.js");

const session = { permissionMode: "auto-accept" as const, headlessApprovedActions: [] };

function fakeEngine(results: Array<{ scheduleId: string; outcome: string; reason?: string }> | Error) {
  return {
    evaluateOnce: vi.fn(async () => {
      if (results instanceof Error) throw results;
      return results;
    }),
  } as any;
}

beforeEach(() => {
  __resetStartupReconcileForTests({ enabled: false });
});

afterEach(() => {
  stopScheduleTicker();
  __resetScheduleTickerForTests();
  __setSharedScheduleEngineForTests(null);
  __resetStartupReconcileForTests();
  vi.useRealTimers();
});

describe("runBackgroundTick", () => {
  it("summarizes evaluateOnce outcomes", async () => {
    const engine = fakeEngine([
      { scheduleId: "a", outcome: "dispatched" },
      { scheduleId: "b", outcome: "dispatched" },
      { scheduleId: "c", outcome: "skipped-overlap" },
      { scheduleId: "d", outcome: "skipped-capacity", reason: "full" },
      { scheduleId: "e", outcome: "no-occurrence-due" },
    ]);
    const now = new Date("2024-01-01T00:00:00Z");
    const summary = await runBackgroundTick({ scheduleEngine: engine, session, now });

    expect(engine.evaluateOnce).toHaveBeenCalledWith({ nowUtc: now, connectedSessions: [session] });
    expect(summary).toMatchObject({ paused: false, dispatched: 2, skipped: 2, errors: 0 });
    expect(summary.results).toHaveLength(5);
  });

  it("paused → no dispatch, engine not consulted", async () => {
    const engine = fakeEngine([{ scheduleId: "a", outcome: "dispatched" }]);
    const summary = await runBackgroundTick({ scheduleEngine: engine, session, backgroundAutomation: "paused" });
    expect(engine.evaluateOnce).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ paused: true, dispatched: 0, skipped: 0, errors: 0 });
  });

  it("counts a failing evaluation as an error instead of throwing", async () => {
    const engine = fakeEngine(new Error("disk gone"));
    const summary = await runBackgroundTick({ scheduleEngine: engine, session });
    expect(summary).toMatchObject({ dispatched: 0, skipped: 0, errors: 1, errorMessages: ["disk gone"] });
  });

  it("builds an engine from a provided coordinator (fake) when no engine is given", async () => {
    const coordinator = {
      root: "/tmp/fake",
      repositories: { schedules: { list: vi.fn(async () => []) } },
      authorization: {},
    } as any;
    const summary = await runBackgroundTick({ coordinator, session: [session, session] });
    expect(coordinator.repositories.schedules.list).toHaveBeenCalled();
    expect(summary).toMatchObject({ dispatched: 0, skipped: 0, errors: 0, results: [] });
  });

  it("falls back to the shared schedule engine", async () => {
    const engine = fakeEngine([{ scheduleId: "a", outcome: "dispatched" }]);
    __setSharedScheduleEngineForTests(engine);
    const summary = await runBackgroundTick({ session });
    expect(summary.dispatched).toBe(1);
  });
});

describe("startScheduleTicker drives runBackgroundTick", () => {
  it("honours backgroundAutomation paused on each tick", async () => {
    vi.useFakeTimers();
    const engine = fakeEngine([]);
    __setSharedScheduleEngineForTests(engine);
    let mode: "on" | "paused" = "paused";
    startScheduleTicker(() => session, 50, { getBackgroundAutomation: () => mode });

    await vi.advanceTimersByTimeAsync(50);
    expect(engine.evaluateOnce).not.toHaveBeenCalled();

    mode = "on";
    await vi.advanceTimersByTimeAsync(50);
    expect(engine.evaluateOnce).toHaveBeenCalledTimes(1);
  });
});
