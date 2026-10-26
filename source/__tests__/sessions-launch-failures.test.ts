import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobError, type JobSummary } from "../background-jobs/types.js";
import { launchSessionWorker, SessionWorkerLaunchError, type SessionWorkerLaunchDeps } from "../sessions/launch.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "../sessions/store.js";

let root: string;
let store: SessionRuntimeStore;
let record: SessionRuntimeRecord;
let deps: SessionWorkerLaunchDeps;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-launch-failure-"));
  store = new SessionRuntimeStore(root);
  record = await store.create({ cwd: root, provider: "anthropic", model: "mock", permissionMode: "ask", sandboxRequired: false });
  deps = { store, cliPath: "/opt/agav/build/cli.js", envNames: [], session: { permissionMode: "ask", headlessApprovedActions: [] },
    coordinator: { start: vi.fn(async () => { throw new Error("network response lost"); }), findByRequestId: vi.fn(async () => undefined) } };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function rejected() {
  try { await launchSessionWorker(record, deps); throw new Error("expected launch failure"); }
  catch (error) { expect(error).toBeInstanceOf(SessionWorkerLaunchError); return error as SessionWorkerLaunchError; }
}

describe("session launch failure ownership", () => {
  it.each(["authorization-denied", "capacity-exceeded", "isolation-unavailable", "unsupported-platform"] as const)("terminalizes definite %s preadmission rejection", async code => {
    vi.mocked(deps.coordinator.start).mockRejectedValueOnce(new BackgroundJobError(code, "not admitted"));
    expect(await rejected()).toMatchObject({ admission: "not-admitted", record: { status: "failed", error: "not admitted" } });
    expect(await store.read(record.id)).toMatchObject({ status: "failed", generation: record.generation });
  });

  it("terminalizes missing environment and aborts without admission", async () => {
    vi.stubEnv("AGAV_MISSING_LAUNCH_ENV", undefined);
    deps.envNames = ["AGAV_MISSING_LAUNCH_ENV"];
    expect(await rejected()).toMatchObject({ admission: "not-admitted", record: { status: "failed" } });
    expect(deps.coordinator.start).not.toHaveBeenCalled();
  });

  it("terminalizes an already-aborted launch", async () => {
    deps.session.signal = AbortSignal.abort();
    expect(await rejected()).toMatchObject({ admission: "not-admitted", record: { status: "failed" } });
    expect(deps.coordinator.start).not.toHaveBeenCalled();
  });

  it.each([new Error("network response lost"), new BackgroundJobError("storage-unavailable", "storage failed"),
    new BackgroundJobError("not-found", "record disappeared"), new BackgroundJobError("lock-held", "update failed")])("retains unknown ownership after %s and never retries start even with empty lookup", async error => {
    vi.mocked(deps.coordinator.start).mockRejectedValue(error);
    expect(await rejected()).toMatchObject({ admission: "unknown", record: { status: "starting" } });
    expect(await rejected()).toMatchObject({ admission: "unknown", record: { status: "starting" } });
    expect(deps.coordinator.start).toHaveBeenCalledTimes(1);
  });

  it("reconciles a subsequently discovered job after uncertain admission without replay", async () => {
    await rejected();
    vi.mocked(deps.coordinator.findByRequestId!).mockImplementation(async requestId => ({ requestId, jobId: "job", state: "running", stopState: "none" }) as JobSummary);
    const result = await launchSessionWorker(record, deps);
    expect(result).toMatchObject({ status: "attached", record: { status: "starting", jobId: "job" } });
    expect(result.record.error).toBeUndefined();
    expect(deps.coordinator.start).toHaveBeenCalledTimes(1);
  });

  it("never terminalizes an existing owner when persisting its job fails", async () => {
    vi.mocked(deps.coordinator.findByRequestId!).mockImplementation(async requestId => ({ requestId, jobId: "job", state: "running", stopState: "none" }) as JobSummary);
    const update = vi.spyOn(store, "update").mockRejectedValueOnce(new Error("disk full"));
    expect(await rejected()).toMatchObject({ admission: "unknown", record: { status: "starting" } });
    update.mockRestore();
    expect((await store.read(record.id))?.status).toBe("starting");
    expect(deps.coordinator.start).not.toHaveBeenCalled();
  });
});
