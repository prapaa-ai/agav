/**
 * T12 — Post-reboot identity invalidation.
 *
 * Pure, I/O-free function implementing solution.md §6: "After reboot,
 * invalidate old live identity claims and reconcile as interrupted or
 * unknown according to evidence; never rerun automatically."
 *
 * Boundary note: obtaining an actual boot id/boot time is a
 * platform-specific concern (e.g. reading `/proc/sys/kernel/random/boot_id`
 * on Linux, or an equivalent primitive on macOS/Windows). That capability
 * belongs to a `PlatformAdapter` extension (owned by `platform/*`, T02-T04)
 * or to a caller-supplied value resolved elsewhere — NOT to this directory.
 * This module deliberately only accepts `bootId`/`lastKnownBootId` as
 * already-resolved strings so it stays a pure, deterministic, OS-call-free
 * function that is trivially unit-testable. Do not add OS-specific boot-id
 * reading code here.
 */
import type { JobRecord } from "../types.js";

const INVALIDATABLE_STATES = new Set<JobRecord["state"]>(["running", "starting", "accepted"]);

/**
 * Given the full set of persisted job records and the current vs.
 * last-known boot id, return a NEW array where any record still claiming a
 * pre-reboot live state (`running`/`starting`/`accepted`) has its process
 * identity evidence stripped and its lifecycle demoted to `unknown` — because
 * a PID/ownership handle recorded before a reboot is meaningless afterwards
 * (the OS process table was wiped). Terminal records (`completed`/`failed`/
 * `interrupted`) and already-uncertain records (`unknown`/
 * `recovery-required`) are left completely untouched: their results are
 * either already verified or already flagged, so there is no new evidence a
 * reboot provides about them.
 *
 * This function NEVER launches, retries or cleans up anything — it only
 * relabels evidence so the next explicit reconciliation/observation step can
 * act correctly. It never mutates its inputs; every returned record for a
 * record that needed invalidation is a fresh object, and unaffected records
 * are returned as the SAME object reference (so callers can cheaply detect
 * "nothing changed" via identity comparison if useful), unless the boot id
 * is unchanged, in which case the entire input array is returned unmodified.
 */
export function invalidateIdentitiesAfterReboot(
  records: JobRecord[],
  bootId: string,
  lastKnownBootId: string | undefined,
): JobRecord[] {
  if (bootId === lastKnownBootId) {
    // No reboot observed since these records were last touched: nothing to
    // invalidate.
    return records;
  }

  return records.map((record) => {
    if (!INVALIDATABLE_STATES.has(record.state)) {
      return record;
    }

    const next: JobRecord = { ...record };
    delete next.identity;
    delete next.ownershipHandle;
    delete next.supervisorIdentity;
    delete next.supervisorOwnershipHandle;
    next.state = "unknown";
    next.uncertaintyReason = "machine rebooted since this job was last observed; prior process identity is invalid";
    return next;
  });
}
