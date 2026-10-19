/**
 * WP-01 — additive contract changes to `types.ts` (Phase 0 of
 * docs/design/job-workflow-implementation-plan.md). Mostly compile-time
 * checks: if any of these optional members are removed or made required,
 * `tsc --noEmit` fails on this file.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BACKGROUND_JOBS_STORAGE_VERSION,
  BackgroundJobError,
  DEFAULT_RESOURCE_LIMITS,
  type BackgroundJobErrorCode,
  type CoordinatorClient,
  type JobSummary,
  type ResourceLimits,
  type StartJobRequest,
} from "../types.js";

describe("types contract (WP-01)", () => {
  it("StartJobRequest accepts optional env values and partial limits", () => {
    const minimal: StartJobRequest = {
      requestId: "r1",
      invocation: { mode: "direct", executable: "/bin/echo", args: ["hi"] },
      cwd: "/tmp",
      isolation: { backend: "none", required: false },
    };
    const full: StartJobRequest = {
      ...minimal,
      env: { FOO: "bar" },
      limits: { maxConcurrentJobs: 2 },
    };
    expect(minimal.env).toBeUndefined();
    expect(full.env).toEqual({ FOO: "bar" });
    expectTypeOf<NonNullable<StartJobRequest["env"]>>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<NonNullable<StartJobRequest["limits"]>>().toEqualTypeOf<Partial<ResourceLimits>>();
    // A full ResourceLimits (as stored on schedule templates) is assignable too.
    const fromTemplate: StartJobRequest = { ...minimal, limits: DEFAULT_RESOURCE_LIMITS };
    expect(fromTemplate.limits).toBe(DEFAULT_RESOURCE_LIMITS);
  });

  it("CoordinatorClient.findByRequestId is optional and returns JobSummary | undefined", () => {
    expectTypeOf<ReturnType<NonNullable<CoordinatorClient["findByRequestId"]>>>().toEqualTypeOf<
      Promise<JobSummary | undefined>
    >();
    // Implementations without it still satisfy the interface (compile-time check).
    const assertAssignable = (client: Omit<CoordinatorClient, "findByRequestId">): CoordinatorClient => client;
    expect(typeof assertAssignable).toBe("function");
  });

  it("supports the store-version-newer error code and keeps storage version 1", () => {
    const code: BackgroundJobErrorCode = "store-version-newer";
    const error = new BackgroundJobError(code, "store is newer");
    expect(error.code).toBe("store-version-newer");
    expect(error.name).toBe("BackgroundJobError");
    expect(BACKGROUND_JOBS_STORAGE_VERSION).toBe(1);
  });
});
