import type { ScheduledTask } from "../config/scheduler.js";

/**
 * Why a scheduled task did not fire.
 *
 * A skip is always recorded, never silent. A nightly job that quietly stopped
 * running for two weeks is worse than one that fails loudly, because nothing
 * tells you to go looking.
 */
export type SkipReason =
  | "disabled"
  | "already-running"
  | "already-fired"
  | "missed-outside-grace";

export interface TickDecision {
  task: ScheduledTask;
  /** Whether this task should start now. */
  fire: boolean;
  /** Set when the task is due but deliberately not started. */
  skip?: SkipReason;
  /**
   * Whether this is a catch-up of a minute that passed while nothing was running,
   * rather than the current minute arriving on schedule.
   */
  catchUp?: boolean;
  /** Minutes of drift being recovered, for catch-up fires. */
  minutesLate?: number;
}

/** Minutes since local midnight. Stable identifier for a scheduled minute. */
export function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Local day the minute belongs to, as days since the epoch. */
export function localDay(date: Date): number {
  // Shift onto a timeline where local midnight is a day boundary, then count days.
  // Without the shift a zone east of UTC maps local midnight into the previous UTC
  // day, and two consecutive local days would compare equal.
  return Math.floor((date.getTime() - date.getTimezoneOffset() * 60_000) / (24 * 60 * 60 * 1000));
}


/** Whether a minute is a given number of minutes after `from`, same day. */
function isAfterMinute(minute: number, from: number): boolean {
  // `now` may have wrapped past midnight, so compare modulo a day.
  const DAY = 24 * 60;
  const delta = (minute - from + DAY) % DAY;
  return delta > 0;
}

/**
 * Decide which tasks should fire at `now`.
 *
 * Pure, so the same rules can be exercised in a test and reused by both the
 * interactive ticker and a headless daemon. No clock reads and no I/O happen
 * here: `isTaskRunning` is supplied by the caller.
 */
export function planTick(
  tasks: ScheduledTask[],
  now: Date,
  isTaskRunning: (task: ScheduledTask) => boolean = () => false,
  matches: (cron: string, date: Date) => boolean = () => false,
): TickDecision[] {
  const nowMinute = minutesSinceMidnight(now);
  const decisions: TickDecision[] = [];

  for (const task of tasks) {
    if (!task.enabled) {
      decisions.push({ task, fire: false, skip: "disabled" });
      continue;
    }

    const dueNow = matches(task.cron, now);
    const lastFired = task.lastFiredMinute;
    const today = localDay(now);

    // Already consumed this minute, on this day. The day matters: a task fired at
    // 03:00 yesterday is due again at 03:00 today, and comparing the minute alone
    // silently skipped it for a whole day.
    if (dueNow && lastFired !== undefined && lastFired === nowMinute && task.lastFiredDay === today) {
      decisions.push({ task, fire: false, skip: "already-fired" });
      continue;
    }

    if (!dueNow) {
      // Not due right now. The question is whether this is a quiet part of the
      // schedule, or a fire that passed while nothing was running. A cron
      // expression has no rest period of its own, so a gap between the last
      // consumed minute and now that a matching minute would have filled is a
      // missed fire. It is always recorded; the catch-up window decides whether
      // it is also replayed on the next tick that matches.
      const missed = missedMinute(task, nowMinute, lastFired, matches, now);
      if (missed !== undefined) {
        decisions.push({ task, fire: false, skip: "missed-outside-grace" });
      } else {
        decisions.push({ task, fire: false });
      }
      continue;
    }

    // Due. Refuse to overlap with a run still in flight, unless opted out.
    if (task.skipIfRunning !== false && isTaskRunning(task)) {
      decisions.push({ task, fire: false, skip: "already-running" });
      continue;
    }

    const catchUp = lastFired !== undefined && isAfterMinute(nowMinute, lastFired);
    decisions.push({
      task,
      fire: true,
      ...(catchUp ? { catchUp: true, minutesLate: (nowMinute - (lastFired ?? nowMinute) + 24 * 60) % (24 * 60) } : {}),
    });
  }

  return decisions;
}

/**
 * Whether a matching minute passed between the last consumed one and now.
 *
 * Records the gap whenever one exists. Whether that gap is later replayed is a
 * separate decision made by the next due tick; this function only establishes
 * that a fire was missed, which must never be silent.
 *
 * The look-back is bounded by the catch-up window, or a full hour when none is
 * set: a machine that was off for a week reports the gap but is not made to
 * replay a hundred fires on the next tick.
 */
function missedMinute(
  task: ScheduledTask,
  nowMinute: number,
  lastFired: number | undefined,
  matches: (cron: string, date: Date) => boolean,
  now: Date,
): number | undefined {
  if (lastFired === undefined) return undefined;

  const DAY = 24 * 60;
  // A variable named `window` here would shadow the DOM global and is confusing
  // to read; `lookback` states its purpose.
  const lookback = Math.max(task.catchUpWithinMinutes ?? 0, 60);

  for (let back = 1; back <= lookback; back++) {
    const minute = (nowMinute - back + DAY) % DAY;
    if (minute === lastFired) break;
    const probe = new Date(now);
    probe.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    if (matches(task.cron, probe)) return minute;
  }
  return undefined;
}

/** Fold tick decisions back into a task, recording what happened. */
export function applyDecision(task: ScheduledTask, decision: TickDecision, now: Date): ScheduledTask {
  const stamp = now.toISOString();

  if (decision.fire) {
    return {
      ...task,
      // Record the minute consumed, distinct from when the run started.
      lastFiredMinute: minutesSinceMidnight(now),
    lastFiredDay: localDay(now),
      lastRunAt: stamp,
      missedRuns: 0,
      lastSkipReason: undefined,
    };
  }

  if (decision.skip === "already-fired" || decision.skip === "disabled") return task;

  // A deliberate skip, or a gap: record it so an operator can see it.
  return {
    ...task,
    lastSkipReason: describeSkip(decision.skip),
    missedRuns: decision.skip === "missed-outside-grace" ? (task.missedRuns ?? 0) + 1 : task.missedRuns,
    // A missed fire still consumes the minute, so the same gap is not counted on
    // every subsequent tick.
    ...(decision.skip === "missed-outside-grace" ? { lastFiredMinute: minutesSinceMidnight(now), lastFiredDay: localDay(now) } : {}),
  };
}

export function describeSkip(skip: SkipReason | undefined): string | undefined {
  switch (skip) {
    case "already-running":
      return "previous run still in flight";
    case "already-fired":
      return undefined;
    case "missed-outside-grace":
      return "missed while not running, outside the catch-up window";
    case "disabled":
      return undefined;
    default:
      return undefined;
  }
}

/** One-line summary for the schedule list. */
export function formatTaskStatus(task: ScheduledTask): string {
  if (task.lastSkipReason) return `skipped: ${task.lastSkipReason}`;
  if (task.missedRuns) return `${task.missedRuns} missed`;
  if (!task.lastRunAt) return "never run";
  return `last ${new Date(task.lastRunAt).toLocaleString()}`;
}
