/**
 * T13 — claims.ts (PresentationClaimTracker) unit tests. Pure in-memory
 * logic, no I/O.
 */
import { describe, expect, it } from "vitest";
import { PresentationClaimTracker } from "../mailbox/claims.js";

describe("PresentationClaimTracker", () => {
  it("allows the first claimant and rejects a different second claimant", () => {
    const tracker = new PresentationClaimTracker();
    expect(tracker.tryClaim("ev-1", "a")).toBe(true);
    expect(tracker.tryClaim("ev-1", "b")).toBe(false);
    expect(tracker.getClaimant("ev-1")).toBe("a");
  });

  it("is idempotent for the same claimant re-claiming", () => {
    const tracker = new PresentationClaimTracker();
    expect(tracker.tryClaim("ev-1", "a")).toBe(true);
    expect(tracker.tryClaim("ev-1", "a")).toBe(true);
    expect(tracker.getClaimant("ev-1")).toBe("a");
  });

  it("release is a no-op when called by a non-holder", () => {
    const tracker = new PresentationClaimTracker();
    tracker.tryClaim("ev-1", "a");
    tracker.release("ev-1", "b");
    expect(tracker.getClaimant("ev-1")).toBe("a");
  });

  it("release frees the claim when called by the holder", () => {
    const tracker = new PresentationClaimTracker();
    tracker.tryClaim("ev-1", "a");
    tracker.release("ev-1", "a");
    expect(tracker.getClaimant("ev-1")).toBeUndefined();
    expect(tracker.tryClaim("ev-1", "b")).toBe(true);
  });

  it("releaseAllForClient frees every claim held by that client only", () => {
    const tracker = new PresentationClaimTracker();
    tracker.tryClaim("ev-1", "a");
    tracker.tryClaim("ev-2", "a");
    tracker.tryClaim("ev-3", "b");

    tracker.releaseAllForClient("a");

    expect(tracker.getClaimant("ev-1")).toBeUndefined();
    expect(tracker.getClaimant("ev-2")).toBeUndefined();
    expect(tracker.getClaimant("ev-3")).toBe("b");
  });
});
