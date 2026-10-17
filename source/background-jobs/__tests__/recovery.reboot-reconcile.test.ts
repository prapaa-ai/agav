/**
 * T12 — invalidateIdentitiesAfterReboot tests.
 *
 * Pure function, no I/O: exercised with plain in-memory JobRecord fixtures.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { invalidateIdentitiesAfterReboot } from "../recovery/reboot-reconcile.js";
import type { JobRecord } from "../types.js";

function makeRecord(overrides: Partial<JobRecord>): JobRecord {
  return {
    jobId: randomUUID(),
    requestId: randomUUID(),
    specHash: "test-hash",
    protocolVersion: 1,
    state: "running",
    stopState: "none",
    nonce: randomUUID(),
    ...overrides,
  };
}

describe("invalidateIdentitiesAfterReboot", () => {
  it("invalidates running/starting/accepted records to 'unknown' and strips identity/ownershipHandle when the boot id changed", () => {
    const running = makeRecord({ state: "running", identity: { pid: 1, creationIdentity: "a" }, ownershipHandle: "1", supervisorIdentity: { pid: 2, creationIdentity: "b" }, supervisorOwnershipHandle: "2" });
    const starting = makeRecord({ state: "starting", identity: { pid: 2, creationIdentity: "b" } });
    const accepted = makeRecord({ state: "accepted" });
    const completed = makeRecord({ state: "completed", exitCode: 0 });
    const failed = makeRecord({ state: "failed", exitCode: 1 });
    const interrupted = makeRecord({ state: "interrupted" });
    const unknown = makeRecord({ state: "unknown", uncertaintyReason: "pre-existing" });
    const recoveryRequired = makeRecord({ state: "recovery-required", uncertaintyReason: "pre-existing" });

    const input = [running, starting, accepted, completed, failed, interrupted, unknown, recoveryRequired];
    const result = invalidateIdentitiesAfterReboot(input, "boot-2", "boot-1");

    const byId = new Map(result.map((r) => [r.jobId, r]));

    const newRunning = byId.get(running.jobId)!;
    expect(newRunning.state).toBe("unknown");
    expect(newRunning.identity).toBeUndefined();
    expect(newRunning.ownershipHandle).toBeUndefined();
    expect(newRunning.supervisorIdentity).toBeUndefined();
    expect(newRunning.supervisorOwnershipHandle).toBeUndefined();
    expect(newRunning.uncertaintyReason).toMatch(/rebooted/i);

    const newStarting = byId.get(starting.jobId)!;
    expect(newStarting.state).toBe("unknown");
    expect(newStarting.identity).toBeUndefined();

    const newAccepted = byId.get(accepted.jobId)!;
    expect(newAccepted.state).toBe("unknown");

    // Terminal records untouched.
    expect(byId.get(completed.jobId)).toEqual(completed);
    expect(byId.get(failed.jobId)).toEqual(failed);
    expect(byId.get(interrupted.jobId)).toEqual(interrupted);

    // Already-uncertain records untouched.
    expect(byId.get(unknown.jobId)).toEqual(unknown);
    expect(byId.get(recoveryRequired.jobId)).toEqual(recoveryRequired);
  });

  it("leaves everything untouched when the boot id is unchanged", () => {
    const running = makeRecord({ state: "running", identity: { pid: 1, creationIdentity: "a" } });
    const input = [running];

    const result = invalidateIdentitiesAfterReboot(input, "boot-1", "boot-1");

    expect(result).toBe(input); // same array reference: true no-op
    expect(result[0]).toEqual(running);
  });

  it("treats an undefined lastKnownBootId as 'rebooted' (first observation / no prior record)", () => {
    const running = makeRecord({ state: "running", identity: { pid: 1, creationIdentity: "a" } });
    const result = invalidateIdentitiesAfterReboot([running], "boot-1", undefined);

    expect(result[0]!.state).toBe("unknown");
    expect(result[0]!.identity).toBeUndefined();
  });

  it("does not mutate the input array or its objects", () => {
    const running = makeRecord({ state: "running", identity: { pid: 1, creationIdentity: "a" }, ownershipHandle: "1" });
    const snapshot = JSON.parse(JSON.stringify(running));
    const input = [running];
    Object.freeze(running);
    Object.freeze(input);

    expect(() => invalidateIdentitiesAfterReboot(input, "boot-2", "boot-1")).not.toThrow();

    // Original object/array remain exactly as they were.
    expect(running).toEqual(snapshot);
    expect(input).toHaveLength(1);
    expect(input[0]).toBe(running);
  });

  it("returns fresh objects for invalidated records (not the same reference as input)", () => {
    const running = makeRecord({ state: "running", identity: { pid: 1, creationIdentity: "a" } });
    const result = invalidateIdentitiesAfterReboot([running], "boot-2", "boot-1");

    expect(result[0]).not.toBe(running);
  });
});
