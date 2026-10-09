import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCoordinator } from "../coordinator/service.js";
import { getPlatformAdapter } from "../platform/index.js";
import { JobSupervisor } from "../supervisor/lifecycle.js";
import { DEFAULT_RESOURCE_LIMITS, type LaunchSpec } from "../types.js";

// Capability discovery is not workload enforcement. Even a host with the
// binary installed must not dispatch an isolated spec through a bare spawn.
describe("background workload isolation enforcement", () => {
  it.each(["bubblewrap", "seatbelt"] as const)("refuses %s before approval/persistence even when advertised available", async backend => {
    const root = await mkdtemp(join(tmpdir(), "agav-isolation-safety-"));
    const adapter = await getPlatformAdapter();
    const capabilities = await adapter.detectCapabilities();
    const detect = vi.spyOn(adapter, "detectCapabilities").mockResolvedValue({
      ...capabilities, availableIsolationBackends: [backend],
    });
    try {
      const coordinator = await createCoordinator({ root });
      const put = vi.spyOn(coordinator.repositories.specs, "put");
      const requestId = randomUUID();
      await expect(coordinator.start({
        requestId, invocation: { mode: "direct", executable: process.execPath, args: [] },
        cwd: root, isolation: { backend, required: true },
      }, { permissionMode: "auto-accept", headlessApprovedActions: [] })).rejects.toMatchObject({ code: "isolation-unavailable" });
      expect(put).not.toHaveBeenCalled();
      expect(await coordinator.repositories.specs.get(requestId)).toBeUndefined();
      expect(await coordinator.repositories.jobs.list()).toEqual([]);
    } finally {
      detect.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([true, false])("supervisor refuses a persisted isolated spec before lifecycle/IPC/spawn (required=%s)", async required => {
    const root = await mkdtemp(join(tmpdir(), "agav-supervisor-isolation-"));
    const coordinator = await createCoordinator({ root });
    const get = vi.spyOn(coordinator.repositories.jobs, "get");
    const spec: LaunchSpec = {
      requestId: randomUUID(), invocation: { mode: "direct", executable: process.execPath, args: [] },
      cwd: root, env: {}, credentialRefs: [], isolation: { backend: "bubblewrap", required },
      ownershipScope: "process-group", limits: DEFAULT_RESOURCE_LIMITS,
      headless: false, createdAt: new Date().toISOString(),
    };
    const supervisor = new JobSupervisor({ jobId: randomUUID(), requestId: spec.requestId,
      repositories: coordinator.repositories, root, socketPath: join(root, "unused.sock") });
    try {
      await expect(supervisor.start(spec)).rejects.toMatchObject({ code: "isolation-unavailable" });
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      await supervisor.shutdown();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
