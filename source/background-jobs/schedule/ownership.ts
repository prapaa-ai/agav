/**
 * The single rule for "does this schedule occurrence still own the schedule?", shared by the
 * engine (overlap prevention, deletion) and the UI (whether Delete is offered), so they cannot diverge.
 *
 * - `active`:   its job is not terminal, or it is a recent jobless reservation (dispatch in flight).
 * - `expired`:  a jobless reservation older than the window. Elapsed time alone does not prove the
 *               original dispatcher stopped, so the engine must FENCE it (under the coordinator lock)
 *               before admitting anything else; only then is it safe to ignore.
 * - `inactive`: nothing left to wait for (terminal job, or an occurrence that never launched).
 */
import { isTerminalLifecycle, type JobRecord, type ScheduleOccurrenceRecord } from "../types.js";

/** A reservation without a job record counts as an in-flight dispatch for this long. */
export const PENDING_DISPATCH_WINDOW_MS = 2 * 60 * 1000;

export type OccurrenceOwnership = "active" | "expired" | "inactive";

export function classifyOccurrence(
  occurrence: Pick<ScheduleOccurrenceRecord, "status" | "createdAt" | "requestId">,
  job: Pick<JobRecord, "state"> | undefined,
  nowMs: number,
): OccurrenceOwnership {
  if (!occurrence.requestId) return "inactive";
  // Unknown / recovery-required jobs count as still active.
  if (job !== undefined) return isTerminalLifecycle(job.state) ? "inactive" : "active";
  if (occurrence.status !== "reserved") return "inactive";
  const createdAt = Date.parse(occurrence.createdAt);
  // An unparseable timestamp can never become "recent", so it is expired (and fenced) rather than blocking forever.
  if (Number.isNaN(createdAt)) return "expired";
  return nowMs - createdAt < PENDING_DISPATCH_WINDOW_MS ? "active" : "expired";
}
