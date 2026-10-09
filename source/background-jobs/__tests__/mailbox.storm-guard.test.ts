/**
 * T13 — storm-guard.ts (dedupeEventsForDelivery) unit tests. Pure function,
 * no I/O.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { dedupeEventsForDelivery } from "../mailbox/storm-guard.js";
import type { CompletionEventRecord } from "../types.js";

function makeEvent(overrides: Partial<CompletionEventRecord> = {}): CompletionEventRecord {
  return {
    eventId: randomUUID(),
    jobId: randomUUID(),
    outcome: "completed",
    exitCode: 0,
    signal: null,
    stdoutExcerpt: "",
    stderrExcerpt: "",
    truncated: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("dedupeEventsForDelivery", () => {
  it("keeps only the latest event per jobId", () => {
    const jobId = randomUUID();
    const older = makeEvent({ jobId, createdAt: "2024-01-01T00:00:00.000Z" });
    const newer = makeEvent({ jobId, createdAt: "2024-01-02T00:00:00.000Z" });

    const result = dedupeEventsForDelivery([older, newer]);

    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe(newer.eventId);
  });

  it("preserves all events with distinct jobIds", () => {
    const eventA = makeEvent();
    const eventB = makeEvent();

    const result = dedupeEventsForDelivery([eventA, eventB]);

    expect(result).toHaveLength(2);
    const ids = result.map((e) => e.eventId).sort();
    expect(ids).toEqual([eventA.eventId, eventB.eventId].sort());
  });
});
