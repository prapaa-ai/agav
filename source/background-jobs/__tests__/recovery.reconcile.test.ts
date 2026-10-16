/**
 * T12 — reconcileJob tests.
 *
 * Uses a real temp dir, real `createFileRepositories`, and a minimal real
 * `IpcServer` standing in for a live supervisor (no full `JobSupervisor`
 * needed — we only need to answer `{type:'poll'}` with a fabricated
 * `JobRecord` carrying a specific nonce). `getPlatformAdapter()` is faked via
 * `__setPlatformAdapterForTests` so `verifyAlive` is fully deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createFileRepositories } from "../storage/repositories.js";
import { resolveStorageRoot } from "../storage/paths.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { IpcServer } from "../ipc/server.js";
import { __setPlatformAdapterForTests } from "../platform/index.js";
import { reconcileJob } from "../recovery/reconcile.js";
import { reserveCapacity } from "../coordinator/admission.js";
import type { JobRecord, PlatformAdapter, Repositories } from "../types.js";

let base: string;
let root: string;
let repositories: Repositories;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-bg-recovery-test-"));
  root = await resolveStorageRoot(base);
  repositories = createFileRepositories(root);
});

afterEach(async () => {
  __setPlatformAdapterForTests(null);
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function socketPathFor(jobId: string): string {
  return getSocketPath(root, `job-${jobId}`);
}

function baseRecord(overrides: Partial<JobRecord> = {}): JobRecord {
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

function fakeAdapter(verifyAliveResult: boolean | ((identity: { pid: number }) => boolean)): PlatformAdapter {
  const verifyAlive = typeof verifyAliveResult === "function" ? verifyAliveResult : () => verifyAliveResult;
  return {
    platform: "linux",
    async detectCapabilities() {
      throw new Error("not implemented in fake");
    },
    async canonicalizePath(path: string) {
      return path;
    },
    async acquireLock() {
      return async () => {};
    },
    async launchDetachedSupervisor() {
      throw new Error("not implemented in fake");
    },
    async verifyAlive(identity) {
      return verifyAlive(identity);
    },
    async stopOwnedScope() {
      throw new Error("not implemented in fake");
    },
    async forceStopOwnedScope() {
      throw new Error("not implemented in fake");
    },
  };
}

/** Minimal stand-in for a live supervisor: answers {type:'poll'} with a fixed record. */
async function startFakeSupervisor(jobId: string, pollRecord: JobRecord): Promise<IpcServer> {
  const socketPath = socketPathFor(jobId);
  const server = new IpcServer(socketPath, {
    onRequest: (msg, respond) => {
      if (msg && typeof msg === "object" && (msg as Record<string, unknown>).type === "poll") {
        respond({ type: "poll", job: pollRecord });
        return;
      }
      respond({ type: "error", message: "unexpected request" });
    },
  });
  await server.start();
  return server;
}

describe("reconcileJob", () => {
  it("never touches a terminal (completed) job record", async () => {
    const record = baseRecord({ state: "completed", exitCode: 0, endedAt: new Date().toISOString() });
    await repositories.jobs.create(record);

    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });

    expect(result.action).toBe("none");
    expect(result.record).toEqual(record);

    const onDisk = await repositories.jobs.get(record.jobId);
    expect(onDisk).toEqual(record);
  });

  it("reconnects to a live supervisor with a matching nonce and does not modify on-disk state itself", async () => {
    const nonce = randomUUID();
    const record = baseRecord({ state: "running", nonce, startedAt: new Date().toISOString() });
    await repositories.jobs.create(record);

    const freshlyPolled: JobRecord = { ...record, heartbeatAt: new Date().toISOString() };
    const server = await startFakeSupervisor(record.jobId, freshlyPolled);
    try {
      const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });

      expect(result.action).toBe("reconnected");
      expect(result.record).toEqual(freshlyPolled);

      // The reconciler itself must not have written anything; on-disk state
      // remains exactly what it was before reconciliation (the live
      // supervisor is the sole writer).
      const onDisk = await repositories.jobs.get(record.jobId);
      expect(onDisk).toEqual(record);
    } finally {
      await server.stop();
    }
  });

  it("does NOT treat a live-but-mismatched-nonce response as reconnected (stale/reused socket path)", async () => {
    const record = baseRecord({ state: "running", nonce: randomUUID(), identity: { pid: 999999, creationIdentity: "x" } });
    await repositories.jobs.create(record);

    // Simulate a verifyAlive check: here we want the fall-through path (not
    // reconnected) to then also report process-gone, so this should end in
    // marked-interrupted, never "reconnected".
    __setPlatformAdapterForTests(fakeAdapter(false));

    const differentNonceRecord: JobRecord = { ...record, nonce: randomUUID() };
    const server = await startFakeSupervisor(record.jobId, differentNonceRecord);
    try {
      const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });

      expect(result.action).not.toBe("reconnected");
      expect(result.action).toBe("marked-unknown");
    } finally {
      await server.stop();
    }
  });

  it("marks 'unknown' when IPC is unreachable but verifyAlive confirms the process is still alive", async () => {
    const record = baseRecord({ state: "running", identity: { pid: 12345, creationIdentity: "abc" }, supervisorIdentity: { pid: 54321, creationIdentity: "supervisor" } });
    await repositories.jobs.create(record);

    __setPlatformAdapterForTests(fakeAdapter(true));

    // No fake supervisor started: socket does not exist, IPC unreachable.
    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });

    expect(result.action).toBe("marked-unknown");
    expect(result.record.state).toBe("unknown");
    expect(result.record.uncertaintyReason).toContain("IPC unreachable");

    const onDisk = await repositories.jobs.get(record.jobId);
    expect(onDisk?.state).toBe("unknown");
  });

  it("preserves uncertainty when IPC is unreachable and supervisor is gone, disclosing possible descendants", async () => {
    const record = baseRecord({ state: "running", identity: { pid: 12345, creationIdentity: "abc" }, supervisorIdentity: { pid: 54321, creationIdentity: "supervisor" } });
    await repositories.jobs.create(record);

    __setPlatformAdapterForTests(fakeAdapter(false));

    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });

    expect(result.action).toBe("marked-unknown");
    expect(result.record.state).toBe("unknown");
    expect(result.record.uncertaintyReason).toMatch(/descendants/i);

    const onDisk = await repositories.jobs.get(record.jobId);
    expect(onDisk?.state).toBe("unknown");
  });

  it("preserves uncertainty when running with no supervisor identity and IPC unreachable", async () => {
    const record = baseRecord({ state: "running" });
    await repositories.jobs.create(record);

    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });

    expect(result.action).toBe("marked-unknown");
    expect(result.record.state).toBe("unknown");
  });

  it("marks 'recovery-required' for a 'starting' job with nothing reachable", async () => {
    const record = baseRecord({ state: "starting" });
    await repositories.jobs.create(record);

    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });

    expect(result.action).toBe("marked-recovery-required");
    expect(result.record.state).toBe("recovery-required");
    expect(result.record.uncertaintyReason).toBeDefined();

    const onDisk = await repositories.jobs.get(record.jobId);
    expect(onDisk?.state).toBe("recovery-required");
  });

  it("marks 'recovery-required' for an 'accepted' job with nothing reachable", async () => {
    const record = baseRecord({ state: "accepted" });
    await repositories.jobs.create(record);

    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });

    expect(result.action).toBe("marked-recovery-required");
    expect(result.record.state).toBe("recovery-required");
  });

  it("is idempotent: reconciling an already-'unknown' record with still-no-evidence twice does not flap or error", async () => {
    const record = baseRecord({ state: "unknown", uncertaintyReason: "previous pass", identity: { pid: 1, creationIdentity: "a" } });
    await repositories.jobs.create(record);

    __setPlatformAdapterForTests(fakeAdapter(false));

    const first = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });
    expect(first.action).toBe("none");
    expect(first.record.state).toBe("unknown");

    const second = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });
    expect(second.action).toBe("none");
    expect(second.record.state).toBe("unknown");

    // No writes should have occurred (state remains untouched, same reason).
    const onDisk = await repositories.jobs.get(record.jobId);
    expect(onDisk?.uncertaintyReason).toBe("previous pass");
  });

  it("resolves an 'unknown' record back to 'reconnected' if the supervisor becomes reachable again with a matching nonce", async () => {
    const nonce = randomUUID();
    const record = baseRecord({ state: "unknown", nonce, uncertaintyReason: "previous pass" });
    await repositories.jobs.create(record);

    const freshlyPolled: JobRecord = { ...record, state: "running" };
    const server = await startFakeSupervisor(record.jobId, freshlyPolled);
    try {
      const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });
      expect(result.action).toBe("reconnected");
      expect(result.record.state).toBe("running");
    } finally {
      await server.stop();
    }
  });

  it("marks 'recovery-required' for a 'recovery-required' state is not applicable; 'recovery-required' idempotently stays put with no evidence", async () => {
    const record = baseRecord({ state: "recovery-required", uncertaintyReason: "ambiguous dispatch" });
    await repositories.jobs.create(record);

    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });
    expect(result.action).toBe("none");
    expect(result.record.state).toBe("recovery-required");
  });

  it("probes supervisor identity, never workload identity, and retains capacity without an owned-scope outcome", async () => {
    const record = baseRecord({ identity: { pid: 123, creationIdentity: "workload" }, supervisorIdentity: { pid: 456, creationIdentity: "supervisor" }, ownershipScope: "unverified" });
    await repositories.jobs.create(record);
    const probed: number[] = [];
    __setPlatformAdapterForTests(fakeAdapter(identity => { probed.push(identity.pid); return identity.pid === 456; }));
    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });
    expect(probed).toEqual([456]);
    expect(result.record.state).toBe("unknown");
    expect(result.record.endedAt).toBeUndefined();
    expect(await reserveCapacity(repositories, root, { maxConcurrentJobs: 1 })).toEqual({ granted: false, activeCount: 1 });
  });

  it.each(["unavailable", "456", ""])("does not turn weak supervisor creation identity %j into death evidence", async creationIdentity => {
    const record = baseRecord({ supervisorIdentity: { pid: 456, creationIdentity } });
    await repositories.jobs.create(record);
    const probed: number[] = [];
    __setPlatformAdapterForTests(fakeAdapter(identity => { probed.push(identity.pid); return false; }));
    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });
    expect(probed).toEqual([]);
    expect(result.record.state).toBe("unknown");
    expect(result.record.uncertaintyReason).toMatch(/inconclusive/);
  });

  it("treats a denied supervisor probe as inconclusive rather than terminal death", async () => {
    const record = baseRecord({ supervisorIdentity: { pid: 456, creationIdentity: "strong" } });
    await repositories.jobs.create(record);
    __setPlatformAdapterForTests(fakeAdapter(() => { throw new Error("EPERM"); }));
    const result = await reconcileJob({ jobId: record.jobId, repositories, root, socketPathFor });
    expect(result.record.state).toBe("unknown");
    expect(result.record.uncertaintyReason).toMatch(/inconclusive/);
  });

  it("throws if the jobId does not exist", async () => {
    await expect(reconcileJob({ jobId: randomUUID(), repositories, root, socketPathFor })).rejects.toThrow();
  });
});
