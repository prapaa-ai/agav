import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSummary, SessionPolicySnapshot, StartJobRequest } from "../background-jobs/types.js";
import { launchSessionWorker, sessionWorkerRequestId, sessionWorkerStartRequest, type SessionWorkerLaunchDeps } from "../sessions/launch.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "../sessions/store.js";

const CLI = "/opt/agav/build/cli.js";
let root: string;
let store: SessionRuntimeStore;
let record: SessionRuntimeRecord;
let session: SessionPolicySnapshot;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-session-launch-"));
  store = new SessionRuntimeStore(root);
  record = await store.create({ id: "session-1", generation: "generation-1", cwd: root,
    provider: "anthropic", model: "mock", permissionMode: "ask", sandboxRequired: true });
  session = { permissionMode: "ask", headlessApprovedActions: [], confirmBackgroundAction: vi.fn(async () => true) };
  vi.stubEnv("AGAV_HOME", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function fakeCoordinator() {
  const jobs = new Map<string, JobSummary>();
  const start = vi.fn(async (request: StartJobRequest, _session: SessionPolicySnapshot): Promise<JobSummary> => {
    const job: JobSummary = { jobId: "job-1", requestId: request.requestId, state: "running", stopState: "none" };
    jobs.set(request.requestId, job);
    return job;
  });
  const findByRequestId = vi.fn(async (requestId: string) => jobs.get(requestId));
  return { jobs, start, findByRequestId };
}
function deps(coordinator = fakeCoordinator()): SessionWorkerLaunchDeps {
  return { store, coordinator, cliPath: CLI, envNames: [], session };
}
function existingJob(state: JobSummary["state"] = "running"): JobSummary {
  return { jobId: "existing-job", requestId: sessionWorkerRequestId(record), state, stopState: "none" };
}

describe("session worker request", () => {
  it("has deterministic, generation-specific, unambiguous identities", () => {
    expect(sessionWorkerRequestId(record)).toBe("session-run-9-session-1-generation-1");
    expect(sessionWorkerRequestId({ ...record })).toBe(sessionWorkerRequestId(record));
    expect(sessionWorkerRequestId({ ...record, generation: "generation-2" })).not.toBe(sessionWorkerRequestId(record));
    expect(sessionWorkerRequestId({ id: "a-b", generation: "c" })).not.toBe(sessionWorkerRequestId({ id: "a", generation: "b-c" }));
    expect(() => sessionWorkerRequestId({ id: "../escape", generation: "valid" })).toThrow(/Invalid session runtime id/);
    expect(() => sessionWorkerRequestId({ id: "valid", generation: "../escape" })).toThrow(/Invalid session runtime id/);
  });

  it("builds a compiled manifest invocation with selected names only and no authorization flags", () => {
    vi.stubEnv("AGAV_HOME", root);
    vi.stubEnv("AGAV_SESSION_LAUNCH_SECRET", "credential-not-metadata");
    const request = sessionWorkerStartRequest(record, CLI, ["AGAV_SESSION_LAUNCH_SECRET", "AGAV_SESSION_LAUNCH_SECRET", "AGAV_HOME"], false);
    expect(request).toEqual({ requestId: sessionWorkerRequestId(record),
      invocation: { mode: "direct", executable: process.execPath, args: [CLI, "--internal-session-runner", record.id, record.generation] },
      cwd: root, envInherit: ["AGAV_SESSION_LAUNCH_SECRET", "AGAV_HOME"],
      isolation: { backend: "none", required: false }, headless: true });
    expect(JSON.stringify(request)).not.toContain("credential-not-metadata");
    expect(JSON.stringify(request)).not.toContain("auto-accept");
  });

  it("prepends only the trusted tsx loader for a source entry, not parent runtime flags", () => {
    const original = process.execArgv;
    process.execArgv = ["--inspect=0", "--require", "/untrusted.cjs"];
    try {
      const { invocation } = sessionWorkerStartRequest(record, "/repo/source/cli.tsx", [], false);
      if (invocation.mode !== "direct") throw new Error("expected direct invocation");
      expect(invocation.args).toHaveLength(6);
      expect(invocation.args[0]).toBe("--import");
      expect(invocation.args[1]).toMatch(/^file:\/\/.*tsx/);
      expect(invocation.args.slice(2)).toEqual(["/repo/source/cli.tsx", "--internal-session-runner", record.id, record.generation]);
      expect(invocation.args.join(" ")).not.toMatch(/inspect|untrusted/);
    } finally { process.execArgv = original; }
  });

  it("reexecutes a standalone binary without a virtual entry or loader", () => {
    expect(sessionWorkerStartRequest(record, "/$bunfs/root/cli.tsx", [], true).invocation).toEqual({
      mode: "direct", executable: process.execPath, args: ["--internal-session-runner", record.id, record.generation],
    });
  });
});

describe("launchSessionWorker", () => {
  it("passes the caller's ask policy unchanged and persists the worker job", async () => {
    const coordinator = fakeCoordinator();
    const result = await launchSessionWorker(record, deps(coordinator));
    expect(result.status).toBe("started");
    expect(coordinator.start).toHaveBeenCalledExactlyOnceWith(sessionWorkerStartRequest(record, CLI, []), session);
    expect(coordinator.start.mock.calls[0]![1]).toBe(session);
    expect(session.permissionMode).toBe("ask");
    expect(session.headlessApprovedActions).toEqual([]);
    expect(session.confirmBackgroundAction).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({ jobId: "job-1", generation: record.generation, status: "starting", permissionMode: "ask", sandboxRequired: true });
    expect(await new SessionRuntimeStore(root).read(record.id)).toEqual(result.record);
  });

  it("refuses a missing caller policy rather than defaulting to auto-accept", async () => {
    const coordinator = fakeCoordinator();
    const { session: _session, ...withoutSession } = deps(coordinator);
    await expect(launchSessionWorker(record, withoutSession as SessionWorkerLaunchDeps)).rejects.toThrow(/requires a caller policy snapshot/);
    expect(coordinator.start).not.toHaveBeenCalled();
    expect(coordinator.findByRequestId).not.toHaveBeenCalled();
    expect(await store.read(record.id)).toEqual(record);
  });

  it("refuses missing selected environment names without exposing values or starting a worker", async () => {
    vi.stubEnv("AGAV_SESSION_LAUNCH_SECRET", "credential-not-metadata");
    vi.stubEnv("AGAV_SESSION_LAUNCH_MISSING", undefined);
    const coordinator = fakeCoordinator();
    await expect(launchSessionWorker(record, { ...deps(coordinator), envNames: ["AGAV_SESSION_LAUNCH_SECRET", "AGAV_SESSION_LAUNCH_MISSING"] }))
      .rejects.toThrow("Session worker was not launched: missing selected environment variable(s): AGAV_SESSION_LAUNCH_MISSING");
    expect(coordinator.start).not.toHaveBeenCalled();
    expect(await store.read(record.id)).toEqual(record);
    expect(await readFile(join(store.directory(record.id), "runtime.json"), "utf8")).not.toContain("credential-not-metadata");
  });

  it("deduplicates a repeated launch using the durable generation, even with a stale caller record", async () => {
    const coordinator = fakeCoordinator();
    const first = await launchSessionWorker(record, deps(coordinator));
    const second = await launchSessionWorker(record, { ...deps(coordinator), store: new SessionRuntimeStore(root) });
    expect(second.status).toBe("attached");
    expect(second.job).toEqual(first.job);
    expect(second.record.generation).toBe(record.generation);
    expect(coordinator.start).toHaveBeenCalledTimes(1);
    expect(coordinator.findByRequestId.mock.calls).toEqual([[sessionWorkerRequestId(record)], [sessionWorkerRequestId(record)]]);
  });

  it("recovers an admitted worker after its start response is lost without launching again", async () => {
    const coordinator = fakeCoordinator();
    const job = existingJob();
    coordinator.start.mockImplementationOnce(async () => {
      coordinator.jobs.set(job.requestId, job);
      throw new Error("start response lost");
    });
    const result = await launchSessionWorker(record, deps(coordinator));
    expect(result).toMatchObject({ status: "started", job, record: { jobId: job.jobId, generation: record.generation } });
    expect(await store.read(record.id)).toEqual(result.record);
    expect((await launchSessionWorker(record, deps(coordinator))).status).toBe("attached");
    expect(coordinator.start).toHaveBeenCalledTimes(1);
    expect(coordinator.findByRequestId).toHaveBeenCalledTimes(3);
  });

  it.each(["completed", "failed", "interrupted"] as const)("marks a live runtime interrupted when its existing worker is %s, never replays it", async state => {
    const coordinator = fakeCoordinator();
    const job = existingJob(state);
    coordinator.jobs.set(job.requestId, job);
    await store.update(record.id, record.generation, latest => { latest.status = "needs-approval"; });
    const result = await launchSessionWorker(record, deps(coordinator));
    expect(result.status).toBe("attached");
    expect(result.record).toMatchObject({ jobId: job.jobId, status: "interrupted", generation: record.generation,
      error: `Session worker ended (${state}) before recording completion.` });
    expect(await store.read(record.id)).toEqual(result.record);
    expect(coordinator.start).not.toHaveBeenCalled();
  });

  it("preserves recorded completion when reattaching a terminal worker", async () => {
    const coordinator = fakeCoordinator();
    const job = existingJob("completed");
    coordinator.jobs.set(job.requestId, job);
    await store.update(record.id, record.generation, latest => { latest.status = "completed"; });
    const result = await launchSessionWorker(record, deps(coordinator));
    expect(result.record).toMatchObject({ status: "completed", jobId: job.jobId });
    expect(result.record.error).toBeUndefined();
    expect(coordinator.start).not.toHaveBeenCalled();
  });
});
