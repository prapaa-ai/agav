import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCoordinator } from "../coordinator/service.js";
import { getPlatformAdapter } from "../platform/index.js";
import { DEFAULT_RESOURCE_LIMITS } from "../types.js";

// A persisted PID is not ownership. Never actually signal the process used
// as the reused-PID fixture; the spy makes the pre-fix regression safe.
describe("coordinator cleanup ownership safety", () => {
  it.each([
    { name: "unverified scope", scope: "unverified" as const, creationIdentity: "unavailable", alive: true, handle: String(process.pid), signal: false },
    { name: "missing scope", scope: undefined, creationIdentity: "strong-start", alive: true, handle: String(process.pid), signal: false },
    { name: "stale process-group identity", scope: "process-group" as const, creationIdentity: "strong-start", alive: false, handle: String(process.pid), signal: false },
    { name: "missing creation identity", scope: "process-group" as const, creationIdentity: "", alive: true, handle: String(process.pid), signal: false },
    { name: "unavailable creation identity", scope: "process-group" as const, creationIdentity: "unavailable", alive: true, handle: String(process.pid), signal: false },
    { name: "PID placeholder identity", scope: "process-group" as const, creationIdentity: String(process.pid), alive: true, handle: String(process.pid), signal: false },
    { name: "mismatched group handle", scope: "process-group" as const, creationIdentity: "strong-start", alive: true, handle: String(process.pid + 1), signal: false },
    { name: "fresh matching identity", scope: "process-group" as const, creationIdentity: "strong-start", alive: true, handle: String(process.pid), signal: true },
  ])("cleanup verifies $name before signalling", async ({ scope, creationIdentity, alive, handle, signal }) => {
    const root = await mkdtemp(join(tmpdir(), "agav-cleanup-safety-"));
    const adapter = await getPlatformAdapter();
    const stop = vi.spyOn(adapter, "stopOwnedScope").mockResolvedValue({
      observedStopped: true, escalated: false, verifiedNoDescendants: false, limitations: [],
    });
    const verify = vi.spyOn(adapter, "verifyAlive").mockResolvedValue(alive);
    try {
      const coordinator = await createCoordinator({ root });
      const requestId = randomUUID();
      const jobId = randomUUID();
      await coordinator.repositories.specs.put({
        requestId, invocation: { mode: "direct", executable: process.execPath, args: [] },
        cwd: root, env: {}, credentialRefs: [], isolation: { backend: "none", required: false },
        ownershipScope: "unverified", limits: DEFAULT_RESOURCE_LIMITS,
        headless: false, createdAt: new Date().toISOString(),
      });
      await coordinator.repositories.jobs.create({
        jobId, requestId, specHash: "test", protocolVersion: 1, nonce: randomUUID(),
        state: "completed", stopState: "none", exitCode: 0,
        supervisorIdentity: { pid: process.pid, creationIdentity },
        supervisorOwnershipHandle: handle, supervisorOwnershipScope: scope,
      });
      await coordinator.cleanup(jobId, { permissionMode: "auto-accept", headlessApprovedActions: [] });
      if (signal) {
        expect(verify).toHaveBeenCalledWith({ pid: process.pid, creationIdentity });
        expect(stop).toHaveBeenCalledWith(handle, scope, 3000);
      } else {
        expect(stop).not.toHaveBeenCalled();
      }
      expect((await coordinator.repositories.jobs.get(jobId))?.state).toBe("completed");
    } finally {
      stop.mockRestore();
      verify.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
