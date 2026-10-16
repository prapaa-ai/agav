/**
 * V-7 — `coordinator.reconcile({ olderThanMs })` selection (decision D5).
 *
 * Real temp store + real file repositories. Only the per-job
 * `reconcileJob` is stubbed so we can observe exactly which jobs the sweep
 * attempts (the real one would probe liveness and mutate records); it
 * returns the record unchanged, or throws for designated job ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const attempted: string[] = [];
const failing = new Set<string>();

vi.mock("../recovery/reconcile.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../recovery/reconcile.js")>();
  return {
    ...original,
    reconcileJob: vi.fn(async (args: import("../recovery/reconcile.js").ReconcileJobArgs) => {
      attempted.push(args.jobId);
      if (failing.has(args.jobId)) throw new Error(`boom ${args.jobId}`);
      const record = await args.repositories.jobs.get(args.jobId);
      return { action: "none" as const, record: record! };
    }),
  };
});

import { createCoordinator, type Coordinator } from "../coordinator/service.js";
import { DEFAULT_RESOURCE_LIMITS, type LifecycleState } from "../types.js";

const HOUR = 60 * 60 * 1000;
let root: string;
let coordinator: Coordinator;

beforeEach(async () => {
  attempted.length = 0;
  failing.clear();
  root = await mkdtemp(join(tmpdir(), "agav-reconcile-sel-"));
  coordinator = await createCoordinator({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Seed a job record; `specAgeMs === null` means no spec is persisted. */
async function seed(state: LifecycleState, specAgeMs: number | null): Promise<string> {
  const requestId = randomUUID();
  const jobId = randomUUID();
  if (specAgeMs !== null) {
    await coordinator.repositories.specs.put({
      requestId, invocation: { mode: "direct", executable: process.execPath, args: [] },
      cwd: root, env: {}, credentialRefs: [], isolation: { backend: "none", required: false },
      ownershipScope: "unverified", limits: DEFAULT_RESOURCE_LIMITS,
      headless: false, createdAt: new Date(Date.now() - specAgeMs).toISOString(),
    });
  }
  await coordinator.repositories.jobs.create({
    jobId, requestId, specHash: "test", protocolVersion: 1, nonce: randomUUID(),
    state, stopState: "none",
    ...(state === "completed" ? { exitCode: 0 } : {}),
  });
  return jobId;
}

describe("coordinator.reconcile selection (D5)", () => {
  it("selects running/unknown always, accepted/starting only when old, missing spec as old, skips terminal", async () => {
    const running = await seed("running", 0);
    const unknown = await seed("unknown", 0);
    const acceptedNew = await seed("accepted", 0);
    const acceptedOld = await seed("accepted", 2 * HOUR);
    const startingOld = await seed("starting", 2 * HOUR);
    const startingNew = await seed("starting", 0);
    const completed = await seed("completed", 2 * HOUR);
    const acceptedNoSpec = await seed("accepted", null);

    const results = await coordinator.reconcile({ olderThanMs: HOUR });

    const expected = [running, unknown, acceptedOld, startingOld, acceptedNoSpec];
    expect([...attempted].sort()).toEqual([...expected].sort());
    expect(attempted).not.toContain(acceptedNew);
    expect(attempted).not.toContain(startingNew);
    expect(attempted).not.toContain(completed);
    expect(results.map((s) => s.jobId).sort()).toEqual([...expected].sort());
  });

  it("a per-job reconcile error does not abort the sweep", async () => {
    const bad = await seed("running", 0);
    const good1 = await seed("unknown", 0);
    const good2 = await seed("accepted", 2 * HOUR);
    failing.add(bad);

    const results = await coordinator.reconcile({ olderThanMs: HOUR });

    expect([...attempted].sort()).toEqual([bad, good1, good2].sort());
    expect(results.map((s) => s.jobId).sort()).toEqual([good1, good2].sort());
  });

  it("olderThanMs: 0 treats every non-terminal accepted/starting job as old", async () => {
    const acceptedNew = await seed("accepted", 0);
    const startingNew = await seed("starting", 0);
    await seed("completed", 0);

    await coordinator.reconcile({ olderThanMs: 0 });

    expect([...attempted].sort()).toEqual([acceptedNew, startingNew].sort());
  });
});
