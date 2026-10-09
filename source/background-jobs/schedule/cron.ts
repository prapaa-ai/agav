/**
 * T15 — Pure, timezone-aware cron evaluation. NO I/O lives here.
 *
 * This is a DIFFERENT, materially independent cron evaluator from
 * `source/config/scheduler.ts`'s `cronMatches`/`fieldMatches` (the OLD
 * prompt-schedule feature). That evaluator is loose (silently ignores
 * malformed field parts) and has no timezone concept — it only ever checks
 * fields against `Date.getMinutes()`/`getHours()` etc. in the host's local
 * time. This subsystem's process schedules need (a) rigorous validation
 * that REJECTS malformed cron strings at creation time rather than silently
 * never matching, and (b) genuine IANA-timezone-aware evaluation
 * independent of the host's local timezone, per solution.md §11's DST/
 * timezone rules. Keeping this self-contained (not importing from
 * `config/scheduler.ts`) also respects the module-boundary rule that
 * `background-jobs/*` does not depend on existing command/config wiring.
 */
import { BackgroundJobError } from "../types.js";

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

interface FieldSpec {
  name: keyof CronFields;
  min: number;
  max: number;
}

const FIELD_SPECS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 6 },
];

/** Matches `*`, a step form like `*` followed by `/N`, `N`, `N-M`, `N-M` followed by `/S`, or a comma-separated list of those. */
const PART_PATTERN = /^(\*|\d+)(-\d+)?(\/\d+)?$/;

function validateFieldValue(field: string, spec: FieldSpec): void {
  if (field.length === 0) {
    throw new BackgroundJobError("not-found", `Invalid cron field "${spec.name}": empty.`);
  }
  for (const part of field.split(",")) {
    if (!PART_PATTERN.test(part)) {
      throw new BackgroundJobError(
        "not-found",
        `Invalid cron field "${spec.name}": part "${part}" is not a recognized pattern (expected *, N, N-M, */N, or N-M/S).`,
      );
    }
    const stepMatch = /\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (step <= 0) {
        throw new BackgroundJobError("not-found", `Invalid cron field "${spec.name}": step "${part}" must be positive.`);
      }
    }
    const withoutStep = part.replace(/\/\d+$/, "");
    if (withoutStep === "*") continue;
    const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(withoutStep);
    if (!rangeMatch) {
      throw new BackgroundJobError("not-found", `Invalid cron field "${spec.name}": part "${part}" is malformed.`);
    }
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : start;
    if (start < spec.min || start > spec.max || end < spec.min || end > spec.max) {
      throw new BackgroundJobError(
        "not-found",
        `Invalid cron field "${spec.name}": value out of range [${spec.min}, ${spec.max}] in "${part}".`,
      );
    }
    if (end < start) {
      throw new BackgroundJobError("not-found", `Invalid cron field "${spec.name}": range end before start in "${part}".`);
    }
  }
}

/**
 * Parse and RIGOROUSLY validate a 5-field cron expression. Throws
 * `BackgroundJobError` for any malformed input (wrong field count,
 * out-of-range numbers, garbage characters) rather than silently accepting
 * it and never matching — this is the key difference from the legacy
 * prompt-schedule evaluator in `source/config/scheduler.ts`.
 */
export function parseCronExpression(cron: string): CronFields {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new BackgroundJobError(
      "not-found",
      `Invalid cron expression "${cron}": expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}.`,
    );
  }
  const fields: CronFields = {
    minute: parts[0]!,
    hour: parts[1]!,
    dayOfMonth: parts[2]!,
    month: parts[3]!,
    dayOfWeek: parts[4]!,
  };
  for (const spec of FIELD_SPECS) {
    validateFieldValue(fields[spec.name], spec);
  }
  return fields;
}

function fieldMatchesValue(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const range = stepMatch[1]!;
      const step = Number(stepMatch[2]);
      if (range === "*") {
        if (value % step === 0) return true;
        continue;
      }
      const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!rangeMatch) continue;
      const start = Number(rangeMatch[1]);
      if (value >= start && (rangeMatch[2] === undefined || value <= Number(rangeMatch[2])) && (value - start) % step === 0) return true;
      continue;
    }
    const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!rangeMatch) continue;
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : start;
    if (value >= start && value <= end) return true;
  }
  return false;
}

interface LocalCalendarFields {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0(Sun)-6(Sat)
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * `Intl.DateTimeFormat` construction is comparatively expensive (it parses
 * and compiles the IANA zone's rule set), so we cache one formatter per
 * timezone string instead of constructing one on every call. Without this,
 * `computeNextOccurrence`'s per-candidate-minute loop — which can run up to
 * `MAX_ITERATIONS` (~4 years of minutes) for a structurally-impossible cron
 * expression — rebuilds the formatter roughly two million times and takes
 * on the order of minutes instead of well under a second. This was
 * discovered because the "structurally impossible expression" test
 * (`0 0 30 2 *`, which never matches) timed out before this cache existed.
 */
const LOCAL_FIELDS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getLocalFieldsFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = LOCAL_FIELDS_FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    LOCAL_FIELDS_FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

/**
 * Compute the local calendar fields (year/month/day/hour/minute/weekday)
 * that `utc` corresponds to in `timezone`, using `Intl.DateTimeFormat` —
 * the standard dependency-free approach for IANA-timezone-aware conversion
 * in Node (this repo has no date/timezone library dependency; confirmed by
 * inspecting package.json).
 */
function toLocalFields(utc: Date, timezone: string): LocalCalendarFields {
  const formatter = getLocalFieldsFormatter(timezone);
  const parts = formatter.formatToParts(utc);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayName = get("weekday");
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24, // "24" from hourCycle:h23 at midnight normalizes to 0
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[weekdayName] ?? 0,
  };
}

/**
 * Build a UTC Date from local calendar fields interpreted in `timezone`, by
 * taking a UTC-at-face-value guess and correcting for the timezone's offset
 * at that instant. Used to convert a candidate LOCAL minute back into a
 * concrete UTC instant to test against the cron fields and to verify
 * round-trip correctness (DST spring-forward detection).
 */
function localFieldsToUtcGuess(fields: LocalCalendarFields, timezone: string): Date {
  const naiveUtcMs = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, 0);
  // The naive instant can lie on the other side of an offset transition.
  // Sample both sides, then accept only offsets that realize this exact
  // wall-clock minute. Earliest realization disambiguates repeated times;
  // nonexistent minutes still fail the caller's round-trip validation.
  const offsets = new Set<number>();
  for (const delta of [-86_400_000, 0, 86_400_000]) {
    const sampleMs = naiveUtcMs + delta;
    const local = toLocalFields(new Date(sampleMs), timezone);
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sampleMs);
  }
  let earliestMs = Infinity;
  for (const offset of offsets) {
    const utcMs = naiveUtcMs - offset;
    const realized = toLocalFields(new Date(utcMs), timezone);
    if (realized.year === fields.year && realized.month === fields.month &&
        realized.day === fields.day && realized.hour === fields.hour && realized.minute === fields.minute) {
      earliestMs = Math.min(earliestMs, utcMs);
    }
  }
  return new Date(Number.isFinite(earliestMs) ? earliestMs : naiveUtcMs);
}

/** Deterministic identity for a LOCAL calendar occurrence, independent of which UTC instant realizes it. */
function localKeyFor(fields: LocalCalendarFields, timezone: string): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${timezone}|${fields.year}-${pad(fields.month)}-${pad(fields.day)}T${pad(fields.hour)}:${pad(fields.minute)}`;
}

const MAX_ITERATIONS = 4 * 366 * 24 * 60; // ~4 years of candidate minutes; a generous safety bound, not an expected real-world cost.

/**
 * Find the next UTC instant (strictly after `afterUtc`) at which the LOCAL
 * time in `timezone` matches `fields`. Returns `undefined` if no match is
 * found within the safety bound (a structurally-impossible cron expression,
 * not an expected real-world case).
 *
 * DST handling (solution.md §11):
 *   - Spring-forward (nonexistent local time, e.g. 2:30 AM during a
 *     02:00->03:00 jump): detected by round-tripping the candidate UTC
 *     instant back through `toLocalFields` and confirming it yields the
 *     SAME local hour/minute we targeted. If Node's `Intl`/`Date` arithmetic
 *     shifts it elsewhere (because that wall-clock time never existed),
 *     the candidate is skipped rather than accepted at a shifted time.
 *   - Fall-back (one local time occurring twice in UTC terms): `localKey`
 *     is built purely from LOCAL calendar fields, so both UTC realizations
 *     of the same local minute produce the identical key — reservation
 *     logic (`occurrence-reservation.ts`) naturally treats the second as
 *     "already handled" via that key, satisfying "repeated local times run
 *     at most once per local occurrence" without any special-casing here.
 */
export function computeNextOccurrence(
  fields: CronFields,
  timezone: string,
  afterUtc: Date,
): { utc: Date; localKey: string } | undefined {
  // Start from the local-minute immediately after `afterUtc`, truncated to
  // minute resolution (cron has no second-level granularity).
  const afterLocal = toLocalFields(afterUtc, timezone);
  let candidateUtcMs = Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day, afterLocal.hour, afterLocal.minute, 0);
  // Step forward in LOCAL-minute space: compute candidate local fields,
  // advance by one local minute, convert back to a UTC guess, and repeat.
  let localCandidate: LocalCalendarFields = { ...afterLocal };
  const localSearchEndMs = candidateUtcMs + MAX_ITERATIONS * 60_000;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Advance to the next local minute.
    let { year, month, day, hour, minute } = localCandidate;
    minute += 1;
    if (minute >= 60) {
      minute = 0;
      hour += 1;
      if (hour >= 24) {
        hour = 0;
        // Use a naive UTC-space day increment and re-derive calendar fields
        // via Date's own month/day rollover handling (Date.UTC normalizes
        // out-of-range day/month values), then re-read through toLocalFields
        // for a canonical representation.
        const rolled = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));
        year = rolled.getUTCFullYear();
        month = rolled.getUTCMonth() + 1;
        day = rolled.getUTCDate();
      }
    }
    localCandidate = {
      year,
      month,
      day,
      hour,
      minute,
      // Weekday is recomputed below from the realized UTC instant, since a
      // naive local-field rollover does not know the weekday directly.
      weekday: 0,
    };

    const naiveLocalMs = Date.UTC(year, month - 1, day, hour, minute);
    if (naiveLocalMs > localSearchEndMs) return undefined;
    localCandidate.weekday = new Date(naiveLocalMs).getUTCDay();
    // Date fields can be checked in local calendar space. Skip a whole
    // nonmatching day before doing any expensive timezone conversions.
    if (!fieldMatchesValue(fields.dayOfMonth, day) ||
        !fieldMatchesValue(fields.month, month) ||
        !fieldMatchesValue(fields.dayOfWeek, localCandidate.weekday)) {
      localCandidate.hour = 23;
      localCandidate.minute = 59;
      continue;
    }
    if (!fieldMatchesValue(fields.hour, hour) || !fieldMatchesValue(fields.minute, minute)) continue;

    const candidateUtc = localFieldsToUtcGuess(localCandidate, timezone);
    candidateUtcMs = candidateUtc.getTime();
    if (candidateUtcMs <= afterUtc.getTime()) continue; // guard against any non-monotonic edge case

    // Round-trip verification: does this UTC instant actually realize the
    // local wall-clock time we intended? If not, that local time does not
    // exist (DST spring-forward) — skip it.
    const realized = toLocalFields(candidateUtc, timezone);
    if (realized.hour !== localCandidate.hour || realized.minute !== localCandidate.minute || realized.day !== localCandidate.day) {
      // Do not re-anchor to the realized clock. Offset correction may
      // map a candidate backwards; keep local calendar advancement
      // monotonic instead of repeatedly visiting the same shifted minute.
      continue;
    }
    localCandidate = realized;

    if (
      fieldMatchesValue(fields.minute, realized.minute) &&
      fieldMatchesValue(fields.hour, realized.hour) &&
      fieldMatchesValue(fields.dayOfMonth, realized.day) &&
      fieldMatchesValue(fields.month, realized.month) &&
      fieldMatchesValue(fields.dayOfWeek, realized.weekday)
    ) {
      return { utc: candidateUtc, localKey: localKeyFor(realized, timezone) };
    }
  }

  return undefined;
}
