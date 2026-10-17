/**
 * Primary defense against duplicate dispatch (concurrent passes, clock-rollback replay): the id is
 * derived from scheduleId + localKey, so a second reservation of the same occurrence returns `false`.
 *
 * `occurrenceUtc` is deliberately not part of the id: two UTC instants can realize the same local
 * occurrence during a DST fall-back and must collide.
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
