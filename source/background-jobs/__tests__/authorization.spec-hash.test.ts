/**
 * T08 — spec-hash.ts tests.
 */
import { describe, expect, it } from "vitest";

import { hashLaunchSpecForConsent, type ConsentRelevantSpec } from "../authorization/spec-hash.js";

function baseSpec(overrides: Partial<ConsentRelevantSpec> = {}): ConsentRelevantSpec {
  return {
    invocation: { mode: "direct", executable: "/bin/echo", args: ["hi"] },
    cwd: "/tmp/project",
    env: { PATH: "/usr/bin" },
    credentialRefs: ["GITHUB_TOKEN"],
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

describe("hashLaunchSpecForConsent", () => {
  it("produces identical hashes for logically-identical specs built with different key insertion order", () => {
    const a = baseSpec();

    // Build `b` via a completely different key-insertion order/construction
    // path (spread + reassignment) to exercise the deterministic-stringify
    // key-sorting path rather than relying on object-literal source order.
    const b: ConsentRelevantSpec = {} as ConsentRelevantSpec;
    b.headless = false;
    b.limits = {
      completedLogRetentionDays: 1,
      maxConcurrentJobs: 1,
      aggregatePerUserLogBudgetBytes: 1,
      retainedLogBytesPerJob: 1,
      logSegmentBytes: 1,
    };
    b.ownershipScope = "process-group";
    b.isolation = { required: false, backend: "none" };
    b.credentialRefs = ["GITHUB_TOKEN"];
    b.env = { PATH: "/usr/bin" };
    b.cwd = "/tmp/project";
    b.invocation = { args: ["hi"], executable: "/bin/echo", mode: "direct" };

    expect(hashLaunchSpecForConsent(a)).toBe(hashLaunchSpecForConsent(b));
  });

  it("produces the same hash when only requestId/createdAt would differ (type excludes them)", () => {
    // ConsentRelevantSpec excludes requestId/createdAt at the type level;
    // this confirms determinism: two separately-constructed-but-identical
    // objects of this type hash identically.
    const a = baseSpec();
    const b = baseSpec();
    expect(hashLaunchSpecForConsent(a)).toBe(hashLaunchSpecForConsent(b));
  });

  it("changes when cwd changes", () => {
    const a = baseSpec();
    const b = baseSpec({ cwd: "/tmp/other" });
    expect(hashLaunchSpecForConsent(a)).not.toBe(hashLaunchSpecForConsent(b));
  });

  it("changes when an env value changes even if names are unchanged", () => {
    const a = baseSpec({ env: { PATH: "/usr/bin" } });
    const b = baseSpec({ env: { PATH: "/usr/local/bin" } });
    expect(hashLaunchSpecForConsent(a)).not.toBe(hashLaunchSpecForConsent(b));
  });

  it("changes when isolation backend changes", () => {
    const a = baseSpec({ isolation: { backend: "none", required: false } });
    const b = baseSpec({ isolation: { backend: "bubblewrap", required: false } });
    expect(hashLaunchSpecForConsent(a)).not.toBe(hashLaunchSpecForConsent(b));
  });

  it("changes when credentialRefs names change", () => {
    const a = baseSpec({ credentialRefs: ["GITHUB_TOKEN"] });
    const b = baseSpec({ credentialRefs: ["NPM_TOKEN"] });
    expect(hashLaunchSpecForConsent(a)).not.toBe(hashLaunchSpecForConsent(b));
  });

  it("changes when headless flag changes", () => {
    const a = baseSpec({ headless: false });
    const b = baseSpec({ headless: true });
    expect(hashLaunchSpecForConsent(a)).not.toBe(hashLaunchSpecForConsent(b));
  });
});
