/**
 * WP-06 (0.8 enabler, decision D3) — `start()` forwards `request.env` /
 * `request.limits` into launch-spec normalization, and requests without them
 * produce the same consent hash as before.
 *
 * Imports the coordinator from source; the supervisor launcher is mocked so
 * no real process is spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../coordinator/launcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../coordinator/launcher.js")>();
  return {
    ...original,
    launchSupervisorForJob: vi.fn(async (args: { jobId: string; repositories: import("../types.js").Repositories }) => {
      await args.repositories.jobs.update(args.jobId, { state: "running", startedAt: new Date().toISOString() });
      return { identity: { pid: 0, creationIdentity: "unavailable" }, ownershipHandle: "fake", ownershipScope: "unverified" as const };
    }),
  };
});

import { createCoordinator, type Coordinator } from "../coordinator/service.js";
import { normalizeLaunchSpec, type NormalizeLaunchSpecInput } from "../launch-spec/normalize.js";
import { hashLaunchSpecForConsent } from "../authorization/spec-hash.js";
import { getPlatformAdapter } from "../platform/index.js";
import { DEFAULT_RESOURCE_LIMITS, type LaunchSpec, type SessionPolicySnapshot, type StartJobRequest } from "../types.js";

const session: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };

let base: string;
let coordinator: Coordinator;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-coord-env-limits-"));
  coordinator = await createCoordinator({ root: base });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function request(overrides: Partial<StartJobRequest> = {}): StartJobRequest {
  return {
    requestId: randomUUID(),
    invocation: { mode: "direct", executable: process.execPath, args: ["-e", ""] },
    cwd: base,
    isolation: { backend: "none", required: false },
    ...overrides,
  };
}

function consent(spec: LaunchSpec): string {
  const { requestId: _r, createdAt: _c, ...rest } = spec;
  return hashLaunchSpecForConsent(rest);
}

/** The exact normalize input `start()` built before WP-06 (no env/limits). */
async function legacyNormalize(req: StartJobRequest): Promise<LaunchSpec> {
  const adapter = await getPlatformAdapter();
  const capabilities = await adapter.detectCapabilities();
  const input: NormalizeLaunchSpecInput = {
    requestId: req.requestId,
    invocation: req.invocation,
    cwd: req.cwd,
    platform: adapter.platform,
    isolation: req.isolation,
    ownershipScope: capabilities.strongestOwnershipScope,
    envInherit: req.envInherit,
    headless: req.headless,
    canonicalizeCwd: (path) => adapter.canonicalizePath(path),
  };
  return normalizeLaunchSpec(input);
}

describe("coordinator start() env/limits forwarding (0.8 / D3)", () => {
  it("overlays request.env on the minimal env and merges request.limits over defaults", async () => {
    const req = request({ env: { FOO: "bar", PATH: "/template/bin" }, limits: { maxConcurrentJobs: 9 } });
    await coordinator.start(req, session);

    const spec = await coordinator.repositories.specs.get(req.requestId);
    expect(spec).toBeDefined();
    expect(spec!.env.FOO).toBe("bar");
    // Template values win over inherited essentials.
    expect(spec!.env.PATH).toBe("/template/bin");
    expect(spec!.limits).toEqual({ ...DEFAULT_RESOURCE_LIMITS, maxConcurrentJobs: 9 });
  });

  it("a request without env/limits yields the same consent hash as the pre-WP-06 normalization", async () => {
    const req = request();
    await coordinator.start(req, session);

    const spec = await coordinator.repositories.specs.get(req.requestId);
    const legacy = await legacyNormalize(req);
    expect(consent(spec!)).toBe(consent(legacy));
    const { createdAt: _a, ...specRest } = spec!;
    const { createdAt: _b, ...legacyRest } = legacy;
    expect(specRest).toEqual(legacyRest);
  });

  it("existing-style template values (env: {}, DEFAULT_RESOURCE_LIMITS) don't change the consent hash", async () => {
    const plain = request();
    const templated = request({ env: {}, limits: DEFAULT_RESOURCE_LIMITS });
    await coordinator.start(plain, session);
    await coordinator.start(templated, session);

    const a = await coordinator.repositories.specs.get(plain.requestId);
    const b = await coordinator.repositories.specs.get(templated.requestId);
    expect(consent(a!)).toBe(consent(b!));
  });

  it("an idempotent retry with the same env/limits returns the existing job", async () => {
    const req = request({ env: { FOO: "bar" }, limits: { maxConcurrentJobs: 9 } });
    const first = await coordinator.start(req, session);
    const second = await coordinator.start(req, session);
    expect(second.jobId).toBe(first.jobId);
  });

  it("reusing a requestId with different env is rejected as spec-changed", async () => {
    const req = request({ env: { FOO: "bar" } });
    await coordinator.start(req, session);
    await expect(coordinator.start({ ...req, env: { FOO: "baz" } }, session)).rejects.toMatchObject({
      code: "spec-changed",
    });
  });
});

describe("normalizeLaunchSpec env overlay", () => {
  const baseInput = (overrides: Partial<NormalizeLaunchSpecInput>): NormalizeLaunchSpecInput => ({
    requestId: "req-1",
    invocation: { mode: "direct", executable: "node", args: [] },
    cwd: "/work",
    platform: "linux",
    isolation: { backend: "none", required: false },
    ownershipScope: "process-group",
    canonicalizeCwd: async (p) => p,
    ...overrides,
  });

  it("is a no-op when env is absent or empty", async () => {
    const without = await normalizeLaunchSpec(baseInput({}));
    const empty = await normalizeLaunchSpec(baseInput({ env: {} }));
    expect(empty.env).toEqual(without.env);
  });

  it("applies the overlay before Windows key-casing normalization", async () => {
    const spec = await normalizeLaunchSpec(baseInput({ platform: "win32", env: { Path: "C:\\tpl", foo: "1" } }));
    expect(spec.env.PATH).toBe("C:\\tpl");
    expect(spec.env.FOO).toBe("1");
    expect(Object.keys(spec.env).every((k) => k === k.toUpperCase())).toBe(true);
  });
});
