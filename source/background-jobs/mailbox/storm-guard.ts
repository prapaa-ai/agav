/**
 * T13 — Storm guard for completion-event delivery.
 *
 * solution.md §10 requires the mailbox to "leave retrievable events without
 * an uncontrolled storm." In normal operation `Repositories.events` has
 * exactly one `CompletionEventRecord` per job (T11's lifecycle publishes a
 * single event per terminal transition), so this guard should be a no-op
 * most of the time. It exists purely as a DEFENSIVE backstop against a
 * degenerate/buggy-upstream scenario where more than one event somehow
 * exists for the same `jobId` (e.g. a hypothetical future bug, a corrupted
 * recovery path, or manual data repair gone wrong) — it is not something
 * normal operation is expected to trigger.
 *
 * Its actual job: prevent a caller (the coordinator / a notification
 * fan-out loop) from blasting out N presentations for what is logically one
 * job's result. Given a list of pending events, it keeps at most one event
 * per unique `jobId` — preferring the one with the latest `createdAt` — and
 * drops the rest for delivery purposes. This is a pure function: no I/O, no
 * mutation of its input, no knowledge of claims or acknowledgements.
 */
import type { CompletionEventRecord } from "../types.js";

/**
 * Returns at most one `CompletionEventRecord` per unique `jobId`, preferring
 * the one with the latest `createdAt` (ties keep whichever is encountered
 * first). Events with distinct `jobId`s are all preserved. Input order is
 * not otherwise significant and is not guaranteed to be preserved in the
 * output.
 */
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
