/**
 * T08 — service.ts integration tests (real file-backed grant store, temp dir).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthorizationService } from "../authorization/service.js";
import { createGrantStore } from "../authorization/grant-store.js";
import type { ConsentRelevantSpec } from "../authorization/spec-hash.js";
import type { PlatformCapabilities, SessionPolicySnapshot } from "../types.js";

function baseSpec(overrides: Partial<ConsentRelevantSpec> = {}): ConsentRelevantSpec {
  return {
    invocation: { mode: "direct", executable: "/bin/echo", args: ["hi"] },
    cwd: "/tmp/project",
    env: { PATH: "/usr/bin" },
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
    ...overrides,
  };
}

function session(overrides: Partial<SessionPolicySnapshot> = {}): SessionPolicySnapshot {
  return { permissionMode: "ask", headlessApprovedActions: [], ...overrides };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-bg-auth-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("authorize()", () => {
  it("deny-writes blocks start but allows stop/cleanup/schedule-revoke", async () => {
    const service = createAuthorizationService(root);
    const denyWrites = session({ permissionMode: "deny-writes" });

    const start = await service.authorize("start", baseSpec(), denyWrites);
    expect(start.allowed).toBe(false);

    // stop/cleanup/schedule-revoke are not blocked by deny-writes, but with
    // permissionMode 'deny-writes' (not auto-accept) and no prior grant, they
    // still fall through to "requires interactive confirmation" rather than
    // being denied outright — confirm they are NOT denied for the
    // deny-writes-specific reason.
    const stop = await service.authorize("stop", baseSpec(), denyWrites);
    expect(stop.reason).not.toMatch(/deny-writes/);
    const cleanup = await service.authorize("cleanup", baseSpec(), denyWrites);
    expect(cleanup.reason).not.toMatch(/deny-writes/);
    const revoke = await service.authorize("schedule-revoke", baseSpec(), denyWrites);
    expect(revoke.reason).not.toMatch(/deny-writes/);
  });

  it("auto-accept mints a grant once and reuses it for an identical spec", async () => {
    const service = createAuthorizationService(root);
    const autoAccept = session({ permissionMode: "auto-accept" });
    const spec = baseSpec();

    const first = await service.authorize("start", spec, autoAccept);
    expect(first.allowed).toBe(true);
    expect(first.grant).toBeDefined();

    const second = await service.authorize("start", spec, autoAccept);
    expect(second.allowed).toBe(true);
    expect(second.grant?.grantId).toBe(first.grant?.grantId);

    const grantStore = createGrantStore(root);
    const all = await grantStore.list();
    expect(all.length).toBe(1); // not minted twice
  });

  it("'ask' mode with no existing grant denies, then recordExplicitApproval unblocks a follow-up authorize()", async () => {
    const service = createAuthorizationService(root);
    const ask = session({ permissionMode: "ask" });
    const spec = baseSpec();

    const denied = await service.authorize("start", spec, ask);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/interactive confirmation/);

    const grant = await service.recordExplicitApproval("start", spec);
    expect(grant.action).toBe("start");

    const approvedNow = await service.authorize("start", spec, ask);
    expect(approvedNow.allowed).toBe(true);
    expect(approvedNow.grant?.grantId).toBe(grant.grantId);
  });

  it("headless action without an approved handler is denied even under auto-accept", async () => {
    const service = createAuthorizationService(root);
    const autoAccept = session({ permissionMode: "auto-accept", headlessApprovedActions: [] });

    const result = await service.authorize("start", baseSpec(), autoAccept, { headless: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/[Hh]eadless/);

    // Confirm no grant was minted as a side effect of the denied attempt.
    const grantStore = createGrantStore(root);
    expect((await grantStore.list()).length).toBe(0);
  });

  it("headless action succeeds when explicitly approved in the session snapshot", async () => {
    const service = createAuthorizationService(root);
    const autoAccept = session({ permissionMode: "auto-accept", headlessApprovedActions: ["start"] });

    const result = await service.authorize("start", baseSpec(), autoAccept, { headless: true });
    expect(result.allowed).toBe(true);
  });
});

describe("revalidateBeforeDispatch()", () => {
  it("rejects when the spec changed since approval even though the grant is valid and not revoked", async () => {
    const service = createAuthorizationService(root);
    const originalSpec = baseSpec({ cwd: "/tmp/project" });
    const grant = await service.recordExplicitApproval("start", originalSpec);

    const unchanged = await service.revalidateBeforeDispatch(grant.grantId, originalSpec);
    expect(unchanged.allowed).toBe(true);

    const changedSpec = baseSpec({ cwd: "/tmp/different" });
    const changed = await service.revalidateBeforeDispatch(grant.grantId, changedSpec);
    expect(changed.allowed).toBe(false);
    expect(changed.reason).toMatch(/changed since approval/);
  });

  it("rejects an unknown grant id", async () => {
    const service = createAuthorizationService(root);
    const result = await service.revalidateBeforeDispatch("00000000-0000-0000-0000-000000000000", baseSpec());
    expect(result.allowed).toBe(false);
  });
});

describe("revoke()", () => {
  it("makes subsequent auto-accept authorize() mint a new grant, without touching job state", async () => {
    const service = createAuthorizationService(root);
    const autoAccept = session({ permissionMode: "auto-accept" });
    const spec = baseSpec();

    const first = await service.authorize("start", spec, autoAccept);
    await service.revoke(first.grant!.grantId);

    const second = await service.authorize("start", spec, autoAccept);
    expect(second.allowed).toBe(true);
    expect(second.grant?.grantId).not.toBe(first.grant?.grantId);

    const grantStore = createGrantStore(root);
    const all = await grantStore.list();
    expect(all.length).toBe(2);
    const revokedOne = all.find((g) => g.grantId === first.grant!.grantId);
    expect(revokedOne?.revokedAt).toBeDefined();
  });
});

describe("resolveIsolation()", () => {
  const capabilities: PlatformCapabilities = {
    platform: "linux",
    availableIsolationBackends: ["bubblewrap"],
    strongestOwnershipScope: "process-group",
    supportsGracefulApplicationShutdown: true,
    supportsDelegatedCgroup: false,
    nativeHelperAvailable: true,
    limitations: [],
  };
  const service = createAuthorizationService("/unused-for-pure-fn");

  it("passes through an available backend", () => {
    const result = service.resolveIsolation({ backend: "bubblewrap", required: true }, capabilities);
    expect(result).toEqual({ backend: "bubblewrap", refused: false });
  });

  it("refuses a required-and-unavailable backend", () => {
    const result = service.resolveIsolation({ backend: "seatbelt", required: true }, capabilities);
    expect(result.refused).toBe(true);
  });

  it("still refuses a not-required-but-unavailable backend (no silent downgrade)", () => {
    const result = service.resolveIsolation({ backend: "seatbelt", required: false }, capabilities);
    expect(result.refused).toBe(true);
  });

  it("never refuses explicitly approved backend:'none'", () => {
    const result = service.resolveIsolation({ backend: "none", required: false }, capabilities);
    expect(result).toEqual({ backend: "none", refused: false });
  });
});

describe("aggregateRestrictivePolicy()", () => {
  it("blocks new launches when any connected session is deny-writes", () => {
    const service = createAuthorizationService("/unused-for-pure-fn");
    const result = service.aggregateRestrictivePolicy([
      session({ permissionMode: "auto-accept" }),
      session({ permissionMode: "deny-writes" }),
      session({ permissionMode: "ask" }),
    ]);
    expect(result.blocksNewLaunches).toBe(true);
  });

  it("does not block when no session is deny-writes", () => {
    const service = createAuthorizationService("/unused-for-pure-fn");
    const result = service.aggregateRestrictivePolicy([session({ permissionMode: "ask" }), session({ permissionMode: "auto-accept" })]);
    expect(result.blocksNewLaunches).toBe(false);
  });
});
