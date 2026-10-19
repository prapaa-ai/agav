/**
 * T05 — storage/repositories.ts tests.
 *
 * Uses real temp directories (mkdtemp) and the real Linux platform adapter
 * for locking/canonicalization (this repo's dev/CI sandbox runs on Linux);
 * no mocking of fs or the platform adapter's lock/canonicalize primitives.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createFileRepositories } from "../storage/repositories.js";
import { resolveStorageRoot } from "../storage/paths.js";
import { withJobLock } from "../storage/single-writer-lock.js";
import { BackgroundJobError } from "../types.js";
import type { JobRecord, LaunchSpec, ScheduleOccurrenceRecord } from "../types.js";

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "agav-bg-storage-test-"));
  const root = await resolveStorageRoot(base);
  return { root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function makeSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    requestId: randomUUID(),
    invocation: { mode: "direct", executable: "/bin/echo", args: ["hi"] },
    cwd: "/tmp",
    env: {},
    credentialRefs: [],
    isolation: { backend: "none", required: false },
    ownershipScope: "process-group",
    limits: {
      logSegmentBytes: 1,
      retainedLogBytesPerJob: 1,
      aggregatePerUserLogBudgetBytes: 1,
      maxConcurrentJobs: 1,
      completedLogRetentionDays: 1,
    },
    headless: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: randomUUID(),
    requestId: randomUUID(),
    specHash: "hash",
    protocolVersion: 1,
    state: "accepted",
    stopState: "none",
    nonce: randomUUID(),
    ...overrides,
  };
}

describe("storage/repositories", () => {
  it("jobs.create/get/update/list round-trip", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const job = makeJob();

      await repos.jobs.create(job);
      const fetched = await repos.jobs.get(job.jobId);
      expect(fetched).toEqual(job);

      await repos.jobs.update(job.jobId, { state: "running", startedAt: "2024-01-01T00:00:00.000Z" });
      const updated = await repos.jobs.get(job.jobId);
      expect(updated?.state).toBe("running");
      expect(updated?.startedAt).toBe("2024-01-01T00:00:00.000Z");
      // Unrelated fields survive the patch.
      expect(updated?.nonce).toBe(job.nonce);

      const list = await repos.jobs.list();
      expect(list.map((j) => j.jobId)).toEqual([job.jobId]);

      await expect(repos.jobs.get("does-not-exist")).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("jobs.create rejects a duplicate jobId", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const job = makeJob();
      await repos.jobs.create(job);
      await expect(repos.jobs.create(job)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("jobs.update rejects an unknown jobId", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      await expect(repos.jobs.update("nonexistent-job", { state: "running" })).rejects.toMatchObject({
        code: "not-found",
      });
    } finally {
      await cleanup();
    }
  });

  it("jobs.resolvePrefix: unique, ambiguous and not-found", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const a = makeJob({ jobId: "aaaa1111" });
      const b = makeJob({ jobId: "aaaa2222" });
      const c = makeJob({ jobId: "bbbb3333" });
      await repos.jobs.create(a);
      await repos.jobs.create(b);
      await repos.jobs.create(c);

      await expect(repos.jobs.resolvePrefix("bbbb")).resolves.toBe("bbbb3333");

      await expect(repos.jobs.resolvePrefix("aaaa")).rejects.toMatchObject({ code: "ambiguous-id" });

      // Exact full-id match takes priority over any other overlapping prefix match.
      await expect(repos.jobs.resolvePrefix("aaaa1111")).resolves.toBe("aaaa1111");

      await expect(repos.jobs.resolvePrefix("zzzz")).rejects.toMatchObject({ code: "not-found" });
    } finally {
      await cleanup();
    }
  });

  it("specs.put is immutable: identical spec retried is a no-op, a different spec for the same requestId throws", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const spec = makeSpec();

      await repos.specs.put(spec);
      // Idempotent retry with the exact same spec succeeds silently.
      await expect(repos.specs.put(spec)).resolves.toBeUndefined();

      const fetched = await repos.specs.get(spec.requestId);
      expect(fetched).toEqual(spec);

      const changedSpec: LaunchSpec = { ...spec, cwd: "/different" };
      await expect(repos.specs.put(changedSpec)).rejects.toMatchObject({ code: "spec-changed" });

      // The original spec on disk must be unaffected by the rejected write.
      const stillOriginal = await repos.specs.get(spec.requestId);
      expect(stillOriginal).toEqual(spec);
    } finally {
      await cleanup();
    }
  });

  it("occurrences.reserve is atomic-create-exclusive: duplicate reservation returns false, not an error", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const occurrence: ScheduleOccurrenceRecord = {
        occurrenceId: randomUUID(),
        scheduleId: randomUUID(),
        occurrenceKey: "2024-01-01T00:00:00",
        requestId: randomUUID(),
        status: "reserved",
        createdAt: new Date().toISOString(),
      };

      await expect(repos.occurrences.reserve(occurrence)).resolves.toBe(true);
      await expect(repos.occurrences.reserve(occurrence)).resolves.toBe(false);

      const list = await repos.occurrences.listForSchedule(occurrence.scheduleId);
      expect(list).toHaveLength(1);
      expect(list[0]?.occurrenceId).toBe(occurrence.occurrenceId);

      await repos.occurrences.update(occurrence.occurrenceId, { status: "dispatched" });
      const afterUpdate = await repos.occurrences.listForSchedule(occurrence.scheduleId);
      expect(afterUpdate[0]?.status).toBe("dispatched");
    } finally {
      await cleanup();
    }
  });

  it("events.listPending excludes events that already have an ack", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const jobId = randomUUID();
      const eventA = {
        eventId: randomUUID(),
        jobId,
        outcome: "completed" as const,
        exitCode: 0,
        signal: null,
        stdoutExcerpt: "",
        stderrExcerpt: "",
        truncated: false,
        createdAt: new Date().toISOString(),
      };
      const eventB = { ...eventA, eventId: randomUUID() };

      await repos.events.create(eventA);
      await repos.events.create(eventB);

      let pending = await repos.events.listPending();
      expect(pending.map((e) => e.eventId).sort()).toEqual([eventA.eventId, eventB.eventId].sort());

      await repos.acks.create({ eventId: eventA.eventId, clientId: "client-1", acknowledgedAt: new Date().toISOString() });

      pending = await repos.events.listPending();
      expect(pending.map((e) => e.eventId)).toEqual([eventB.eventId]);

      const ack = await repos.acks.get(eventA.eventId);
      expect(ack?.clientId).toBe("client-1");
      expect(await repos.acks.get(eventB.eventId)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("controlIntents.create/update/listForJob", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const jobId = randomUUID();
      const intent = {
        id: randomUUID(),
        jobId,
        kind: "stop" as const,
        requestedAt: new Date().toISOString(),
        status: "pending" as const,
      };
      await repos.controlIntents.create(intent);
      await repos.controlIntents.update(intent.id, { status: "acknowledged" });

      const list = await repos.controlIntents.listForJob(jobId);
      expect(list).toHaveLength(1);
      expect(list[0]?.status).toBe("acknowledged");

      await expect(repos.controlIntents.listForJob("other-job")).resolves.toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("schedules.put/get/list", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const schedule = {
        scheduleId: randomUUID(),
        version: 1,
        cron: "0 * * * *",
        timezone: "UTC",
        launchSpecTemplate: makeSpec() as any,
        grantId: randomUUID(),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      await repos.schedules.put(schedule);
      await expect(repos.schedules.get(schedule.scheduleId)).resolves.toEqual(schedule);
      const list = await repos.schedules.list();
      expect(list.map((s) => s.scheduleId)).toEqual([schedule.scheduleId]);
    } finally {
      await cleanup();
    }
  });

  it("corrupt job record is quarantined, not silently reported as missing/empty", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      const jobId = randomUUID();
      const jobsDirPath = join(root, "jobs");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(jobsDirPath, { recursive: true });
      await writeFile(join(jobsDirPath, `${jobId}.json`), "{ this is not valid json", "utf8");

      await expect(repos.jobs.get(jobId)).rejects.toMatchObject({ code: "storage-unavailable" });

      // The corrupt file must have been moved into quarantine/, not deleted
      // and not left silently readable as "missing".
      const quarantineFiles = await readdir(join(root, "quarantine"));
      expect(quarantineFiles.some((f) => f.startsWith(`${jobId}.json.corrupt-`))).toBe(true);

      // `get()` already quarantined (moved aside) the corrupt file above, so
      // re-write a second corrupt record to prove `list()` independently
      // surfaces quarantine errors rather than silently treating a corrupt
      // record as an empty/missing result.
      const jobId2 = randomUUID();
      await writeFile(join(jobsDirPath, `${jobId2}.json`), "{ also not valid json", "utf8");
      await expect(repos.jobs.list()).rejects.toMatchObject({ code: "storage-unavailable" });

      const quarantineFilesAfterList = await readdir(join(root, "quarantine"));
      expect(quarantineFilesAfterList.some((f) => f.startsWith(`${jobId2}.json.corrupt-`))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("withJobLock serializes concurrent access: a second concurrent acquire fails with lock-held", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      let releaseFirst: (() => void) | undefined;
      const firstLockHeld = new Promise<void>((resolveHeld) => {
        void withJobLock(root, jobId, () => {
          resolveHeld();
          return new Promise<void>((resolveRelease) => {
            releaseFirst = resolveRelease;
          });
        });
      });

      await firstLockHeld;
      await expect(withJobLock(root, jobId, async () => {})).rejects.toMatchObject({ code: "lock-held" });

      releaseFirst?.();
    } finally {
      await cleanup();
    }
  });

  it("resolveStorageRoot rejects a network/UNC-looking path", async () => {
    await expect(resolveStorageRoot("\\\\server\\share")).rejects.toMatchObject({ code: "storage-unavailable" });
    await expect(resolveStorageRoot("smb://server/share")).rejects.toMatchObject({ code: "storage-unavailable" });
  });

  it("job paths reject unsafe/path-traversal-looking ids", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const repos = createFileRepositories(root);
      await expect(repos.jobs.get("../../etc/passwd")).rejects.toBeInstanceOf(BackgroundJobError);
      await expect(repos.jobs.get("../../etc/passwd")).rejects.toMatchObject({ code: "not-found" });
    } finally {
      await cleanup();
    }
  });
});
