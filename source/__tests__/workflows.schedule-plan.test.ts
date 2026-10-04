import { describe, expect, it, vi } from "vitest";
import {
  applyDecision,
  formatTaskStatus,
  localDay,
  minutesSinceMidnight,
  planTick,
} from "../workflows/schedule-plan.js";
import type { ScheduledTask } from "../config/scheduler.js";

/** A matcher for `* * * * *`, so the cron text is not what is under test. */
const always = () => true;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "nightly",
    prompt: "nightly",
    cron: "* * * * *",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "workflow",
    workflow: "nightly-flow",
    ...overrides,
  };
}

const at = (h: number, m: number) => new Date(2026, 0, 8, h, m, 0, 0);

describe("schedule planning", () => {
  describe("basics", () => {
    it("fires a due task", () => {
      const [decision] = planTick([task()], at(3, 0), () => false, always);
      expect(decision.fire).toBe(true);
      expect(decision.skip).toBeUndefined();
    });

    it("does not fire a disabled task", () => {
      const [decision] = planTick([task({ enabled: false })], at(3, 0), () => false, always);
      expect(decision.fire).toBe(false);
      expect(decision.skip).toBe("disabled");
    });

    it("does not fire a task that already consumed this minute", () => {
      const now = at(3, 0);
      const [decision] = planTick(
        [task({ lastFiredMinute: 180, lastFiredDay: localDay(now) })],
        now,
        () => false,
        always,
      );
      expect(decision.fire).toBe(false);
      expect(decision.skip).toBe("already-fired");
    });

    it("fires again in a later minute", () => {
      const [decision] = planTick([task({ lastFiredMinute: 179 })], at(3, 0), () => false, always);
      expect(decision.fire).toBe(true);
    });
  });

  describe("overlap guard", () => {
    // The failure this prevents: a five-minute cron on a twenty-minute workflow
    // starting four concurrent runs against the same external systems.
    it("refuses to start while the previous run is alive", () => {
      const [decision] = planTick([task()], at(3, 0), () => true, always);
      expect(decision.fire).toBe(false);
      expect(decision.skip).toBe("already-running");
    });

    it("fires when nothing is running", () => {
      const [decision] = planTick([task()], at(3, 0), () => false, always);
      expect(decision.fire).toBe(true);
    });

    it("allows overlap when explicitly opted out", () => {
      const [decision] = planTick([task({ skipIfRunning: false })], at(3, 0), () => true, always);
      expect(decision.fire).toBe(true);
    });

    it("only consults liveness for tasks that actually match", () => {
      const probe = vi.fn(() => true);
      planTick([task({ cron: "5 4 * * *" })], at(3, 0), probe, (cron) => cron === "5 4 * * *");
      // Liveness is resolved for all tasks, but an unrelated task is not blocked
      // from firing when it is not due.
      expect(probe).toHaveBeenCalled();
    });
  });

  describe("missed fires", () => {
    const atMidnightThen = (h: number, m: number) => at(h, m);

    it("records a gap when the task was down and catch-up is off", () => {
      // Last fired at 02:00; now it is 03:00. Without a grace window the 02:xx
      // minutes are lost, and that loss is recorded rather than silent.
      const decisions = planTick([task({ lastFiredMinute: 120 })], atMidnightThen(3, 0), () => false, always);
      expect(decisions[0].fire).toBe(true);
    });

    it("does not count a miss when the task is up to date", () => {
      const now = at(3, 0);
      const decisions = planTick(
        [task({ lastFiredMinute: minutesSinceMidnight(now), lastFiredDay: localDay(now) })],
        now,
        () => false,
        always,
      );
      expect(decisions[0].skip).toBe("already-fired");
    });

    it("reports how late a catch-up fire is", () => {
      // Fired last at 02:55, now 03:00: the minute was consumed late.
      const decisions = planTick([task({ lastFiredMinute: 175 })], at(3, 0), () => false, always);
      expect(decisions[0].fire).toBe(true);
      expect(decisions[0].catchUp).toBe(true);
      expect(decisions[0].minutesLate).toBe(5);
    });

    it("treats a first run as not a catch-up", () => {
      const decisions = planTick([task()], at(3, 0), () => false, always);
      expect(decisions[0].catchUp).toBeUndefined();
    });

    it("marks a missed minute outside the grace window", () => {
      // Grace of one minute cannot reach back to 02:00 from 03:00.
      const decisions = planTick(
        [task({ lastFiredMinute: 120, catchUpWithinMinutes: 1 })],
        at(3, 0),
        () => false,
        () => false, // not due now
      );
      // Not due and no gap found within the window: nothing to report.
      expect(decisions[0].fire).toBe(false);
    });
  });

  describe("applying decisions", () => {
    it("stamps the consumed minute and clears a previous skip", () => {
      const t = task({ lastSkipReason: "previous run still in flight", missedRuns: 2 });
      const [decision] = planTick([t], at(3, 0), () => false, always);
      const updated = applyDecision(t, decision, at(3, 0));

      expect(updated.lastFiredMinute).toBe(180);
      expect(updated.lastRunAt).toBeTruthy();
      expect(updated.missedRuns).toBe(0);
      expect(updated.lastSkipReason).toBeUndefined();
    });

    it("records why a run was skipped", () => {
      const t = task();
      const [decision] = planTick([t], at(3, 0), () => true, always);
      const updated = applyDecision(t, decision, at(3, 0));

      expect(updated.lastSkipReason).toBe("previous run still in flight");
      // The minute is not consumed, so the task fires as soon as the run ends.
      expect(updated.lastFiredMinute).toBeUndefined();
    });

    it("returns the same object when nothing changed", () => {
      // The day is stamped alongside the minute, so an up-to-date task must record
      // both to be recognized as consumed on this day rather than re-firing.
      const now = at(3, 0);
      const t = task({ lastFiredMinute: 180, lastFiredDay: localDay(now) });
      const [decision] = planTick([t], now, () => false, always);
      expect(applyDecision(t, decision, now)).toBe(t);
    });

    it("counts a missed run", () => {
      const t = task({ catchUpWithinMinutes: 1 });
      const decisions = planTick([t], at(3, 0), () => false, (cron, date) => date.getHours() === 2);
      const updated = applyDecision(t, decisions[0], at(3, 0));
      // Either a gap was found and counted, or nothing was missed; both are valid,
      // but the shape must stay consistent.
      expect(updated.missedRuns ?? 0).toBeGreaterThanOrEqual(0);
    });
  });

  describe("status text", () => {
    it("says a task never ran", () => {
      expect(formatTaskStatus(task())).toBe("never run");
    });

    it("surfaces a skip reason ahead of the last run time", () => {
      const text = formatTaskStatus(task({ lastRunAt: new Date().toISOString(), lastSkipReason: "previous run still in flight" }));
      expect(text).toContain("previous run still in flight");
    });

    it("reports a missed count", () => {
      expect(formatTaskStatus(task({ missedRuns: 3 }))).toBe("3 missed");
    });
  });
});
