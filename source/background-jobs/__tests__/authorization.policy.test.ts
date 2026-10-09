/**
 * T08 — policy.ts tests (pure functions, no I/O).
 */
import { describe, expect, it } from "vitest";

import { isBlockedByDenyWrites, isHeadlessActionApproved, isWriteAction } from "../authorization/policy.js";
import type { SessionPolicySnapshot } from "../types.js";

describe("isWriteAction", () => {
  it("is true for start/stop/cleanup/schedule-create", () => {
    expect(isWriteAction("start")).toBe(true);
    expect(isWriteAction("stop")).toBe(true);
    expect(isWriteAction("cleanup")).toBe(true);
    expect(isWriteAction("schedule-create")).toBe(true);
  });

  it("is false for schedule-revoke", () => {
    expect(isWriteAction("schedule-revoke")).toBe(false);
  });
});

describe("isBlockedByDenyWrites", () => {
  it("blocks start and schedule-create", () => {
    expect(isBlockedByDenyWrites("start")).toBe(true);
    expect(isBlockedByDenyWrites("schedule-create")).toBe(true);
  });

  it("never blocks stop, cleanup, or schedule-revoke (emergency/cleanup path)", () => {
    expect(isBlockedByDenyWrites("stop")).toBe(false);
    expect(isBlockedByDenyWrites("cleanup")).toBe(false);
    expect(isBlockedByDenyWrites("schedule-revoke")).toBe(false);
  });
});

describe("isHeadlessActionApproved", () => {
  it("is false when the approved-actions list is empty (absent a handler is not consent)", () => {
    const session: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };
    expect(isHeadlessActionApproved("start", session)).toBe(false);
  });

  it("is true only when the action is explicitly listed", () => {
    const session: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: ["start"] };
    expect(isHeadlessActionApproved("start", session)).toBe(true);
    expect(isHeadlessActionApproved("stop", session)).toBe(false);
  });
});
