/**
 * Pure, IANA-timezone-aware cron evaluation, intentionally independent of `config/scheduler.ts`:
 * that evaluator ignores malformed parts and only knows the host's local time, whereas these
 * schedules need strict validation at creation time and a configurable timezone.
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

const fieldMin = (name: keyof CronFields): number => FIELD_SPECS.find((s) => s.name === name)!.min;
const MINUTE_MIN = fieldMin("minute");
const HOUR_MIN = fieldMin("hour");
const DAY_OF_MONTH_MIN = fieldMin("dayOfMonth");
const MONTH_MIN = fieldMin("month");
const DAY_OF_WEEK_MIN = fieldMin("dayOfWeek");

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

/** Throws on any malformed input rather than accepting an expression that would never match. */
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

/** Wildcard steps count from the field's `min` (day-of-month and month cycle 1, 3, 5, ...). */
function fieldMatchesValue(field: string, value: number, min: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const range = stepMatch[1]!;
      const step = Number(stepMatch[2]);
      if (range === "*") {
        if (value >= min && (value - min) % step === 0) return true;
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

/** Constructing `Intl.DateTimeFormat` is expensive and the search loop runs up to ~2M iterations, so cache one per timezone. */
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

/** Converts a local wall-clock minute to a UTC instant; the caller round-trips the result to detect DST gaps. */
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

/** Independent of which UTC instant realizes the minute, so a DST fall-back repeat yields the same key. */
function localKeyFor(fields: LocalCalendarFields, timezone: string): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${timezone}|${fields.year}-${pad(fields.month)}-${pad(fields.day)}T${pad(fields.hour)}:${pad(fields.minute)}`;
}

const MAX_ITERATIONS = 4 * 366 * 24 * 60; // ~4 years of candidate minutes

/**
 * Next UTC instant strictly after `afterUtc` whose local time in `timezone` matches `fields`;
 * `undefined` if none within the bound (a structurally impossible expression).
 *
 * DST: a spring-forward nonexistent local time is skipped (detected by round-tripping the candidate).
 * A fall-back repeated minute yields the same `localKey`, so reservation runs it at most once.
 */
export function computeNextOccurrence(
  fields: CronFields,
  timezone: string,
  afterUtc: Date,
): { utc: Date; localKey: string } | undefined {
  const afterLocal = toLocalFields(afterUtc, timezone);
  let candidateUtcMs = Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day, afterLocal.hour, afterLocal.minute, 0);
  // Steps forward in local-minute space, converting each candidate back to UTC.
  let localCandidate: LocalCalendarFields = { ...afterLocal };
  const localSearchEndMs = candidateUtcMs + MAX_ITERATIONS * 60_000;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let { year, month, day, hour, minute } = localCandidate;
    minute += 1;
    if (minute >= 60) {
      minute = 0;
      hour += 1;
      if (hour >= 24) {
        hour = 0;
        // Date.UTC normalizes the out-of-range day/month rollover.
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
      weekday: 0, // set below
    };

    const naiveLocalMs = Date.UTC(year, month - 1, day, hour, minute);
    if (naiveLocalMs > localSearchEndMs) return undefined;
    localCandidate.weekday = new Date(naiveLocalMs).getUTCDay();
    // Date fields can be checked in local calendar space. Skip a whole
    // nonmatching day before doing any expensive timezone conversions.
    if (!fieldMatchesValue(fields.dayOfMonth, day, DAY_OF_MONTH_MIN) ||
        !fieldMatchesValue(fields.month, month, MONTH_MIN) ||
        !fieldMatchesValue(fields.dayOfWeek, localCandidate.weekday, DAY_OF_WEEK_MIN)) {
      localCandidate.hour = 23;
      localCandidate.minute = 59;
      continue;
    }
    if (!fieldMatchesValue(fields.hour, hour, HOUR_MIN) || !fieldMatchesValue(fields.minute, minute, MINUTE_MIN)) continue;

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
      fieldMatchesValue(fields.minute, realized.minute, MINUTE_MIN) &&
      fieldMatchesValue(fields.hour, realized.hour, HOUR_MIN) &&
      fieldMatchesValue(fields.dayOfMonth, realized.day, DAY_OF_MONTH_MIN) &&
      fieldMatchesValue(fields.month, realized.month, MONTH_MIN) &&
      fieldMatchesValue(fields.dayOfWeek, realized.weekday, DAY_OF_WEEK_MIN)
    ) {
      return { utc: candidateUtc, localKey: localKeyFor(realized, timezone) };
    }
  }

  return undefined;
}
