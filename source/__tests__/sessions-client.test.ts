import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinatorClient, JobSummary, SessionPolicySnapshot } from "../background-jobs/types.js";
import { BackgroundJobError } from "../background-jobs/types.js";
import { inputHash } from "../workflows/decisions.js";
import type { PendingSessionApproval } from "../sessions/approvals.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "../sessions/store.js";
import { sessionWorkerRequestId } from "../sessions/launch.js";
import { answerSessionApproval, readSessionSnapshot, stopSessionExecution, subscribeSession } from "../sessions/client.js";

const shared = vi.hoisted(() => ({ getCoordinator: vi.fn() }));
vi.mock("../background-jobs-integration.js", () => ({ getSharedCoordinator: shared.getCoordinator }));
let root: string;
let store: SessionRuntimeStore;
let record: SessionRuntimeRecord;
let job: JobSummary;
const poll = vi.fn<() => Promise<JobSummary>>();
const stop = vi.fn<CoordinatorClient["stop"]>();

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "agav-session-client-"));
  store = new SessionRuntimeStore(root);
  record = await store.create({ id: "session-1", generation: "generation-1", cwd: root,
    provider: "anthropic", model: "mock", permissionMode: "ask", sandboxRequired: false, jobId: "job-exact" });
  job = { jobId: "job-exact", requestId: sessionWorkerRequestId(record), state: "running", stopState: "none" };
  poll.mockImplementation(async () => job);
  stop.mockImplementation(async () => job);
  shared.getCoordinator.mockResolvedValue({ poll, stop });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function approval(): Promise<PendingSessionApproval> {
  const input = { path: "example", content: "hello" };
  const item: PendingSessionApproval = { version: 1, approvalId: "approval-1", sessionId: record.id,
    generation: record.generation, inputHash: inputHash(input), createdAt: new Date().toISOString(), toolName: "write_file", input };
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(store.directory(record.id), "approvals"));
  await writeFile(join(store.directory(record.id), "approvals", "approval-1.json"), JSON.stringify(item));
  return item;
}

describe("session attachment snapshots", () => {
  it("reads the durable transcript and pending consent without acquiring an owner", async () => {
    const item = await approval();
    const first = await readSessionSnapshot(record.id, store);
    expect(first).toEqual({ record, approvals: [item] });
    expect(await readSessionSnapshot(record.id, new SessionRuntimeStore(root))).toEqual(first);
    expect(poll).toHaveBeenCalledWith("job-exact");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(store.directory(record.id))).toEqual(expect.arrayContaining(["runtime.json", "approvals"]));
    expect((await readdir(store.directory(record.id))).some(name => name.startsWith("owner-"))).toBe(false);
  });

  it.each(["completed", "failed", "interrupted"] as const)("reconciles confirmed %s workers, never exposing old approvals", async state => {
    await approval();
    job.state = state;
    const snapshot = await readSessionSnapshot(record.id, store);
    expect(snapshot.record).toMatchObject({ status: "interrupted", generation: record.generation,
      error: `Session worker ended (${state}) before recording completion.` });
    expect(snapshot.approvals).toEqual([]);
    expect(await store.read(record.id)).toEqual(snapshot.record);
  });

  it.each(["completed", "failed", "interrupted", "cancelled"] as const)("preserves the worker's recorded %s result", async status => {
    await store.update(record.id, record.generation, current => { current.status = status; });
    job.state = "failed";
    expect((await readSessionSnapshot(record.id, store)).record.status).toBe(status);
    expect(poll).not.toHaveBeenCalled();
  });

  it.each(["unknown", "recovery-required", "accepted", "starting"] as const)("does not falsely interrupt %s workers", async state => {
    job.state = state;
    expect((await readSessionSnapshot(record.id, store)).record).toEqual(record);
  });

  it("keeps durable state when the coordinator is unavailable or the job is absent", async () => {
    const item = await approval();
    shared.getCoordinator.mockRejectedValueOnce(new Error("offline"));
    expect(await readSessionSnapshot(record.id, store)).toEqual({ record, approvals: [item] });
    poll.mockRejectedValueOnce(new BackgroundJobError("not-found", "gone"));
    expect(await readSessionSnapshot(record.id, store)).toEqual({ record, approvals: [item] });
    await store.update(record.id, record.generation, current => { delete current.jobId; });
    const calls = poll.mock.calls.length;
    expect((await readSessionSnapshot(record.id, store)).record.status).toBe("starting");
    expect(poll).toHaveBeenCalledTimes(calls);
  });

  it("rejects missing sessions and wrong coordinator identities", async () => {
    await expect(readSessionSnapshot("missing", store)).rejects.toThrow(/missing|not found/i);
    job.jobId = "job-exact-but-different";
    job.state = "failed";
    await expect(readSessionSnapshot(record.id, store)).rejects.toThrow(/identity/i);
    expect(await store.read(record.id)).toEqual(record);
  });

  it("does not overwrite completion or a changed job during a slow poll", async () => {
    poll.mockImplementationOnce(async () => {
      await store.update(record.id, record.generation, current => { current.status = "completed"; });
      return { ...job, state: "failed" };
    });
    expect((await readSessionSnapshot(record.id, store)).record.status).toBe("completed");
    await store.update(record.id, record.generation, current => { current.status = "running"; });
    poll.mockImplementationOnce(async () => {
      await store.update(record.id, record.generation, current => { current.jobId = "new-job"; });
      return { ...job, state: "failed" };
    });
    expect((await readSessionSnapshot(record.id, store)).record).toMatchObject({ status: "running", jobId: "new-job" });
  });
});

describe("session presentation polling", () => {
  it("polls immediately, serializes slow reads, and suppresses snapshots after disposal", async () => {
    let release!: (value: JobSummary) => void;
    poll.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const dispose = subscribeSession(record.id, { onSnapshot, onError }, { store, intervalMs: 1 });
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(poll).toHaveBeenCalledTimes(1);
    dispose();
    dispose();
    release(job);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("continues after errors and detaches without denying pending approvals", async () => {
    const item = await approval();
    const read = vi.spyOn(store, "read").mockRejectedValueOnce("read failed");
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const dispose = subscribeSession(record.id, { onSnapshot, onError }, { store, intervalMs: 1 });
    try {
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
      await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledWith({ record, approvals: [item] }));
    } finally { dispose(); }
    read.mockRestore();
    expect(await readSessionSnapshot(record.id, store)).toEqual({ record, approvals: [item] });
    await expect(readFile(join(store.directory(record.id), "approvals", "approval-1.decided.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("suppresses late errors after unsubscribe", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(store, "read").mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const dispose = subscribeSession(record.id, { onSnapshot, onError }, { store });
    dispose();
    reject(new Error("late"));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("explicit session actions", () => {
  it("forwards the exact approval generation, input hash, and choice", async () => {
    const item = await approval();
    await expect(answerSessionApproval(record.id, { ...item, generation: "stale" }, "yes", store)).rejects.toThrow(/stale/);
    await expect(answerSessionApproval(record.id, { ...item, inputHash: "stale" }, "yes", store)).rejects.toThrow(/stale/);
    await expect(answerSessionApproval(record.id, { ...item, sessionId: "other" }, "yes", store)).rejects.toThrow(/session|identity/i);
    const choice = { choice: "no" as const, feedback: "not this change" };
    expect(await answerSessionApproval(record.id, item, choice, store)).toMatchObject({ won: true, record: {
      generation: item.generation, inputHash: item.inputHash, result: choice,
    } });
  });

  it("stops the exact job with the caller policy and signal unchanged", async () => {
    const policy: SessionPolicySnapshot = { permissionMode: "ask", headlessApprovedActions: [],
      signal: new AbortController().signal, confirmBackgroundAction: vi.fn(async () => false) };
    await stopSessionExecution(record.id, policy, store);
    expect(stop).toHaveBeenCalledExactlyOnceWith("job-exact", policy);
    expect(stop.mock.calls[0]?.[1]).toBe(policy);
    expect(policy.confirmBackgroundAction).not.toHaveBeenCalled();
    expect(await store.read(record.id)).toEqual(record);
  });

  it("propagates stop denial/unavailability and never falls back to an owner pid", async () => {
    const kill = vi.spyOn(process, "kill");
    const policy: SessionPolicySnapshot = { permissionMode: "ask", headlessApprovedActions: [] };
    stop.mockRejectedValueOnce(new Error("denied"));
    await expect(stopSessionExecution(record.id, policy, store)).rejects.toThrow("denied");
    shared.getCoordinator.mockRejectedValueOnce(new Error("offline"));
    await expect(stopSessionExecution(record.id, policy, store)).rejects.toThrow("offline");
    await store.update(record.id, record.generation, current => { delete current.jobId; current.ownerPid = process.pid; });
    await expect(stopSessionExecution(record.id, policy, store)).rejects.toThrow(/worker|job/i);
    expect(kill).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await store.read(record.id))?.status).toBe("starting");
  });
});
