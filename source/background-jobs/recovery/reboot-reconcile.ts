import type { JobRecord } from "../types.js";

const INVALIDATABLE_STATES = new Set<JobRecord["state"]>(["running", "starting", "accepted"]);

/**
 * After a reboot, live-state records lose their (now meaningless) process identity and become
 * `unknown`. Pure: never relaunches or cleans up, never mutates inputs; unaffected records keep
 * their object identity. The boot ids are supplied by the caller to keep this OS-call-free.
 */
export function invalidateIdentitiesAfterReboot(
  records: JobRecord[],
  bootId: string,
  lastKnownBootId: string | undefined,
): JobRecord[] {
  if (bootId === lastKnownBootId) {
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
