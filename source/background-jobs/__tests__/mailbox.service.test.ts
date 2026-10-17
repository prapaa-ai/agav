/**
 * T13 — mailbox-service.ts tests.
 *
 * Uses real temp directories + the real `createFileRepositories` (T05) —
 * no mocking of storage. Events/acks are real files on disk.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createFileRepositories } from "../storage/repositories.js";
import { resolveStorageRoot } from "../storage/paths.js";
import { createMailboxService } from "../mailbox/mailbox-service.js";
import type { CompletionEventRecord, Repositories } from "../types.js";

async function makeRepositories(): Promise<{ repositories: Repositories; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "agav-bg-mailbox-test-"));
  const root = await resolveStorageRoot(base);
  return { repositories: createFileRepositories(root), cleanup: () => rm(base, { recursive: true, force: true }) };
}

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

describe("mailbox-service", () => {
  it("listPendingForPresentation excludes an event that already has a persisted ack", async () => {
    const { repositories, cleanup } = await makeRepositories();
    try {
      const mailbox = createMailboxService(repositories);
      const pendingEvent = makeEvent();
      const ackedEvent = makeEvent();
      await repositories.events.create(pendingEvent);
      await repositories.events.create(ackedEvent);
      await repositories.acks.create({
        eventId: ackedEvent.eventId,
        clientId: "client-a",
        acknowledgedAt: new Date().toISOString(),
      });

      const pending = await mailbox.listPendingForPresentation();
      const ids = pending.map((e) => e.eventId);
      expect(ids).toContain(pendingEvent.eventId);
      expect(ids).not.toContain(ackedEvent.eventId);
    } finally {
      await cleanup();
    }
  });

  it("claims: first client succeeds, second client fails, same client is idempotent", async () => {
    const { repositories, cleanup } = await makeRepositories();
    try {
      const mailbox = createMailboxService(repositories);
      const event = makeEvent();
      await repositories.events.create(event);

      const first = await mailbox.claimForPresentation(event.eventId, "client-a");
      expect(first.claimed).toBe(true);
      expect(first.event?.eventId).toBe(event.eventId);

      const second = await mailbox.claimForPresentation(event.eventId, "client-b");
      expect(second.claimed).toBe(false);
      expect(second.event).toBeUndefined();

      const firstAgain = await mailbox.claimForPresentation(event.eventId, "client-a");
      expect(firstAgain.claimed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("after acknowledge, a second client's claim attempt fails even with no outstanding in-memory claim", async () => {
    const { repositories, cleanup } = await makeRepositories();
    try {
      const mailbox = createMailboxService(repositories);
      const event = makeEvent();
      await repositories.events.create(event);

      const claim = await mailbox.claimForPresentation(event.eventId, "client-a");
      expect(claim.claimed).toBe(true);

      await mailbox.acknowledge(event.eventId, "client-a");

      // The claim was released by acknowledge(); confirm no claimant remains
      // yet a new client still cannot claim it because it's acknowledged.
      const second = await mailbox.claimForPresentation(event.eventId, "client-b");
      expect(second.claimed).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("releaseAllClaimsForClient frees a claim so a different client can then claim it", async () => {
    const { repositories, cleanup } = await makeRepositories();
    try {
      const mailbox = createMailboxService(repositories);
      const event = makeEvent();
      await repositories.events.create(event);

      const first = await mailbox.claimForPresentation(event.eventId, "client-a");
      expect(first.claimed).toBe(true);

      const blocked = await mailbox.claimForPresentation(event.eventId, "client-b");
      expect(blocked.claimed).toBe(false);

      mailbox.releaseAllClaimsForClient("client-a");

      const nowAllowed = await mailbox.claimForPresentation(event.eventId, "client-b");
      expect(nowAllowed.claimed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("isAcknowledged reflects persisted ack state before/after acknowledge()", async () => {
    const { repositories, cleanup } = await makeRepositories();
    try {
      const mailbox = createMailboxService(repositories);
      const event = makeEvent();
      await repositories.events.create(event);

      expect(await mailbox.isAcknowledged(event.eventId)).toBe(false);

      await mailbox.acknowledge(event.eventId, "client-a");

      expect(await mailbox.isAcknowledged(event.eventId)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("notifySubscribers isolates a throwing subscriber, retries it a bounded number of times, and never rejects", async () => {
    const { repositories, cleanup } = await makeRepositories();
    try {
      const mailbox = createMailboxService(repositories);
      const event = makeEvent();
      await repositories.events.create(event);

      let failingAttempts = 0;
      const failingSubscriber = () => {
        failingAttempts += 1;
        throw new Error("boom");
      };
      let succeedingCalls = 0;
      const succeedingSubscriber = () => {
        succeedingCalls += 1;
      };

      const maxRetries = 2;
      const result = await mailbox.notifySubscribers(event, [failingSubscriber, succeedingSubscriber], {
        maxRetries,
        baseDelayMs: 1,
      });

      expect(result.succeeded).toBe(1);
      expect(succeedingCalls).toBe(1);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0].index).toBe(0);
      expect(typeof result.failed[0].error).toBe("string");
      expect(result.failed[0].error).toContain("boom");
      // 1 initial attempt + maxRetries retries
      expect(failingAttempts).toBe(1 + maxRetries);
    } finally {
      await cleanup();
    }
  });

  it("notifySubscribers never rejects even when a subscriber returns a rejected promise", async () => {
    const { repositories, cleanup } = await makeRepositories();
    try {
      const mailbox = createMailboxService(repositories);
      const event = makeEvent();
      await repositories.events.create(event);

      const asyncFailing = async () => {
        throw new Error("async boom");
      };

      await expect(
        mailbox.notifySubscribers(event, [asyncFailing], { maxRetries: 1, baseDelayMs: 1 }),
      ).resolves.toEqual({ succeeded: 0, failed: [{ index: 0, error: "async boom" }] });
    } finally {
      await cleanup();
    }
  });
});
