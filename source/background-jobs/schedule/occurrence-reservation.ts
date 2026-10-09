/**
 * T15 — Durable occurrence reservation: the primary defense against
 * duplicate schedule dispatch (solution.md §11: "Persisted occurrence
 * identities prevent replay after clock rollback or simultaneous
 * clients."). The occurrenceId is deterministically derived from
 * scheduleId + localKey, so reserving the SAME logical local-time
 * occurrence twice (two concurrent evaluation passes, or a replay caused by
 * clock rollback) always computes the identical id — the underlying
 * repository's exclusive-create semantics (`occurrences.reserve()`) then
 * reject the second attempt by returning `false`, never throwing.
 *
 * `occurrenceUtc` is accepted for API completeness/future use but
 * deliberately NOT used in the id derivation — the LOCAL key, not the UTC
 * instant, defines occurrence identity, per cron.ts's documented DST
 * fall-back handling (two different UTC instants can realize the same
 * local occurrence during a fall-back transition and must collide here).
 */
import { createHash } from "node:crypto";

import type { Repositories, ScheduleOccurrenceRecord, ScheduleRecord } from "../types.js";

export async function reserveOccurrence(args: {
  repositories: Repositories;
  schedule: ScheduleRecord;
  occurrenceUtc: Date;
  localKey: string;
  requestId: string;
}): Promise<{ reserved: boolean; record?: ScheduleOccurrenceRecord }> {
  const { repositories, schedule, localKey, requestId } = args;
  const occurrenceId = createHash("sha256").update(`${schedule.scheduleId}|${localKey}`).digest("hex");
  const record: ScheduleOccurrenceRecord = {
    occurrenceId,
    scheduleId: schedule.scheduleId,
    occurrenceKey: localKey,
    requestId,
    status: "reserved",
    createdAt: new Date().toISOString(),
  };
  const reserved = await repositories.occurrences.reserve(record);
  return reserved ? { reserved: true, record } : { reserved: false };
}
