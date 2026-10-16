/**
 * Defensive backstop: normally there is one completion event per job, but if duplicates ever
 * exist this stops a notification fan-out from announcing one job's result N times.
 */
import type { CompletionEventRecord } from "../types.js";

/** Keeps the latest event per `jobId` (ties keep the first seen); output order is not preserved. */
export function dedupeEventsForDelivery(events: CompletionEventRecord[]): CompletionEventRecord[] {
  const latestByJobId = new Map<string, CompletionEventRecord>();
  for (const event of events) {
    const existing = latestByJobId.get(event.jobId);
    if (existing === undefined || new Date(event.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      latestByJobId.set(event.jobId, event);
    }
  }
  return Array.from(latestByJobId.values());
}
