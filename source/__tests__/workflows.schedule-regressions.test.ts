import { describe, expect, it } from "vitest";
import {
  applyDecision,
  localDay,
  minutesSinceMidnight,
  planTick,
  type TickDecision,
} from "../workflows/schedule-plan.js";
import { cronMatches } from "../config/scheduler.js";
import type { ScheduledTask } from "../config/scheduler.js";

const always = () => true;
const never = () => false;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "nightly",
    cron: "* * * * *",
    prompt: "p",
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as ScheduledTask;
}

function at(h: number, m: number): Date {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function fireDecision(d: TickDecision): boolean {
  return d.fire === true;
}

describe("regressions: scheduler bugs found in review", () => {
  describe("midnight and day boundaries", () => {
    it("localDay distinguishes two consecutive days at the same time of day", () => {
      const now = at(3, 0);
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      expect(localDay(now) - localDay(yesterday)).toBe(1);
    });

    it("localDay is stable across a timezone offset", () => {
      // Two hours apart on the same local day must land on the same day number
      // even when the UTC date has rolled over underneath them.
      const early = at(0, 30);
      const late = at(2, 30);
      expect(localDay(early)).toBe(localDay(late));
    });

    it("a daily task fired yesterday at 03:00 is due again at 03:00 today", () => {
      // The reported bug: minute-of-day alone made this read as already-fired,
      // silently skipping a whole day.
      const now = at(3, 0);
      const yesterday = task({
        lastFiredMinute: minutesSinceMidnight(now),
        lastFiredDay: localDay(now) - 1,
      });
      const decisions = planTick([yesterday], now, never, always);
      expect(decisions[0].fire).toBe(true);
    });

    it("a task fired this minute on this day is still skipped", () => {
      const now = at(3, 0);
      const t = task({
        lastFiredMinute: minutesSinceMidnight(now),
        lastFiredDay: localDay(now),
      });
      const decisions = planTick([t], now, never, always);
      expect(decisions[0].skip).toBe("already-fired");
    });

    it("a task with no recorded day is treated as due, not as already fired", () => {
      // Records written before lastFiredDay existed must not wedge a task.
      const now = at(3, 0);
      const t = task({ lastFiredMinute: minutesSinceMidnight(now) });
      const decisions = planTick([t], now, never, always);
      expect(decisions[0].fire).toBe(true);
    });

    it("stamps the day alongside the minute when a fire is consumed", () => {
      const now = at(3, 0);
      const t = task();
      const [decision] = planTick([t], now, never, always);
      const updated = applyDecision(t, decision, now);
      expect(updated.lastFiredDay).toBe(localDay(now));
      expect(updated.lastFiredMinute).toBe(minutesSinceMidnight(now));
    });
  });

  describe("cron validation", () => {
    it("throws on a malformed expression rather than silently never firing", () => {
      // The reported bug: a typo'd cron was accepted and then never fired and
      // never said why.
      expect(() => cronMatches("* * * *", new Date())).toThrow();
      expect(() => cronMatches("* * * * * *", new Date())).toThrow();
      expect(() => cronMatches("garbage", new Date())).toThrow();
    });

    it("accepts a well-formed expression", () => {
      expect(() => cronMatches("*/5 * * * *", new Date())).not.toThrow();
      expect(() => cronMatches("0 3 * * *", new Date())).not.toThrow();
    });

    it("still matches a valid expression against a matching time", () => {
      expect(cronMatches("0 3 * * *", at(3, 0))).toBe(true);
      expect(cronMatches("0 3 * * *", at(4, 0))).toBe(false);
    });
  });
});
