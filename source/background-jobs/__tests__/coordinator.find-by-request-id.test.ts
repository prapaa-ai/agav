/**
 * WP-06 (plan item 0.5, decision D7) — `findByRequestId` on the coordinator.
 * Uses real temp storage; records are written directly through the
 * repositories, so no supervisor process is launched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createCoordinator, type Coordinator } from "../coordinator/service.js";
import type { CoordinatorClient, JobRecord } from "../types.js";

let base: string;
let coordinator: Coordinator;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-coord-find-req-"));
  coordinator = await createCoordinator({ root: base });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function record(overrides: Partial<JobRecord>): JobRecord {
  return {
    jobId: randomUUID(),
    requestId: randomUUID(),
    specHash: "test",
    protocolVersion: 1,
    state: "completed",
    stopState: "none",
    nonce: randomUUID(),
    exitCode: 0,
    ...overrides,
  };
}

describe("coordinator.findByRequestId (0.5)", () => {
  it("is exposed through the CoordinatorClient interface", () => {
    const client: CoordinatorClient = coordinator;
    expect(typeof client.findByRequestId).toBe("function");
  });

  it("returns undefined when no job has the request id", async () => {
    await coordinator.repositories.jobs.create(record({}));
    expect(await coordinator.findByRequestId(randomUUID())).toBeUndefined();
  });

  it("returns undefined on an empty store", async () => {
    expect(await coordinator.findByRequestId(randomUUID())).toBeUndefined();
  });

  it("returns a JobSummary (not the full JobRecord) for a matching job", async () => {
    const requestId = randomUUID();
    const job = record({ requestId, startedAt: "2024-01-01T00:00:00.000Z", endedAt: "2024-01-01T00:00:01.000Z" });
    await coordinator.repositories.jobs.create(record({}));
    await coordinator.repositories.jobs.create(job);

    const summary = await coordinator.findByRequestId(requestId);
    expect(summary).toEqual({
      jobId: job.jobId,
      requestId,
      state: "completed",
      stopState: "none",
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      exitCode: 0,
    });
    expect(summary).not.toHaveProperty("nonce");
    expect(summary).not.toHaveProperty("specHash");
  });

  it("returns the newest match if several records share a request id", async () => {
    const requestId = randomUUID();
    const older = record({ requestId, startedAt: "2024-01-01T00:00:00.000Z" });
    const newer = record({ requestId, startedAt: "2024-06-01T00:00:00.000Z" });
    await coordinator.repositories.jobs.create(newer);
    await coordinator.repositories.jobs.create(older);

    expect((await coordinator.findByRequestId(requestId))?.jobId).toBe(newer.jobId);
  });
});
