/**
 * Fail-closed proof for REQUIRED sandboxing when isolation is unavailable.
 *
 * `workflows.sandbox-required.test.ts` already covers the runner/workflow policy
 * plumbing. This file proves the primitive that policy rests on, end to end and
 * WITHOUT mocking the enforcement decision: when `sandboxRequired` is on and no
 * OS backend can be applied, `run_command` must refuse rather than silently fall
 * back to unsandboxed execution — and it must refuse before spawning anything.
 *
 * We force the "no backend available" condition deterministically. The honest way
 * to make `detectSandboxBackend()` return "none" is the real user opt-out,
 * `AGAV_NO_SANDBOX=1`: every call re-reads it and short-circuits to "none", so
 * the enforcement branch runs against a genuinely isolation-less result rather
 * than a mock that intra-module calls would bypass anyway.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";

import {
  requireSandbox,
  setSandboxRequired,
  isSandboxRequired,
  runInSandbox,
} from "../utils/sandbox.js";
import { shellTool } from "../tools/shell.js";

beforeEach(() => {
  setSandboxRequired(false);
  delete process.env.AGAV_NO_SANDBOX;
});
afterEach(() => {
  setSandboxRequired(false);
  delete process.env.AGAV_NO_SANDBOX;
});

describe("requireSandbox fails closed", () => {
  it("throws when the effective backend is none", () => {
    expect(() => requireSandbox("none")).toThrow(/Sandbox required/i);
  });

  it("throws when the auto-detected backend is none (isolation-less host)", () => {
    process.env.AGAV_NO_SANDBOX = "1"; // forces detectSandboxBackend() -> "none"
    expect(() => requireSandbox()).toThrow(/no sandbox backend is available/i);
  });

  it("does not throw when a real backend is available", () => {
    for (const backend of ["seatbelt", "bubblewrap", "docker"] as const) {
      expect(() => requireSandbox(backend)).not.toThrow();
    }
  });
});

describe("run_command refuses (fail-closed) when sandboxRequired and no isolation", () => {
  it("refuses without executing when no backend is available", async () => {
    setSandboxRequired(true);
    process.env.AGAV_NO_SANDBOX = "1"; // isolation-less host: detect -> "none"
    expect(isSandboxRequired()).toBe(true);

    const marker = join(tmpdir(), `agav-failclosed-${process.pid}.txt`);
    if (existsSync(marker)) rmSync(marker, { force: true });
    try {
      const result = await shellTool.execute({ command: `printf x > ${JSON.stringify(marker)}` });
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/Sandbox required/i);
      // The clinching proof: the side-effecting command never ran.
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(marker)) rmSync(marker, { force: true });
    }
  });

  it("refuses an explicit 'none' override even with AGAV_NO_SANDBOX=1 set", async () => {
    setSandboxRequired(true);
    process.env.AGAV_NO_SANDBOX = "1";
    const result = await shellTool.execute({ command: "echo hi", sandbox: "none" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Sandbox required/i);
  });
});

describe("sandbox bypass cannot be unlocked by the model", () => {
  it("runInSandbox refuses forceBackend none without the user opt-out, writing nothing", async () => {
    const marker = join(tmpdir(), `agav-modelbypass-${process.pid}.txt`);
    if (existsSync(marker)) rmSync(marker, { force: true });
    try {
      await expect(
        runInSandbox({
          command: `printf x > ${JSON.stringify(marker)}`,
          cwd: tmpdir(),
          timeout: 5000,
          maxBuffer: 1 << 16,
          forceBackend: "none",
        }),
      ).rejects.toThrow(/Sandbox bypass denied/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(marker)) rmSync(marker, { force: true });
    }
  });
});

describe("a backend that fails to launch/apply does NOT fall back to unsandboxed", () => {
  // The distinct failure path the "effective none" tests above do not cover: a
  // real backend is selected, but its launcher is absent / cannot apply. The
  // runtime must surface the error and run nothing — never silently retry
  // unsandboxed. We force a backend whose launcher is guaranteed missing on at
  // least one supported OS; where it IS installed (e.g. seatbelt on macOS,
  // bwrap on Linux CI) the "cannot apply" variant is exercised instead, and the
  // invariant (error returned, side effect absent, backend not downgraded to
  // "none") holds identically.
  function missingBackend(): "bubblewrap" | "seatbelt" {
    // bwrap is not present on macOS/Windows; sandbox-exec is not present on Linux.
    return platform() === "linux" ? "seatbelt" : "bubblewrap";
  }

  it("surfaces the launch error and writes nothing (no unsandboxed fallback)", async () => {
    const backend = missingBackend();
    const marker = join(tmpdir(), `agav-failapply-${process.pid}.txt`);
    if (existsSync(marker)) rmSync(marker, { force: true });
    try {
      const result = await runInSandbox({
        command: `printf x > ${JSON.stringify(marker)}`,
        cwd: tmpdir(),
        timeout: 5000,
        maxBuffer: 1 << 16,
        forceBackend: backend,
      });
      expect(result.error).not.toBeNull();
      // Must not be downgraded to the unsandboxed backend.
      expect(result.backend).toBe(backend);
      // The side-effecting command must not have run via any fallback path.
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(marker)) rmSync(marker, { force: true });
    }
  });

  it("run_command with sandboxRequired reports the failure instead of running unsandboxed", async () => {
    setSandboxRequired(true);
    const backend = missingBackend();
    const marker = join(tmpdir(), `agav-failapply-tool-${process.pid}.txt`);
    if (existsSync(marker)) rmSync(marker, { force: true });
    try {
      const result = await shellTool.execute({ command: `printf x > ${JSON.stringify(marker)}`, sandbox: backend });
      // requireSandbox permits the selected (installed-by-name) backend, so
      // execution proceeds and FAILS at apply/launch — it is reported as an
      // error, and nothing is written. The forbidden outcome is a silent
      // success via an unsandboxed fallback.
      expect(result.isError).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(marker)) rmSync(marker, { force: true });
    }
  });

  it("a backend whose launcher RUNS but exits non-zero also does not fall back", async () => {
    // Distinct from the ENOENT (missing launcher) cases above: here the backend
    // actually RUNS the workload and it exits non-zero. Force docker and run a
    // command that (a) writes a marker to an ABSOLUTE HOST path that is NOT the
    // mounted workspace, then (b) exits 7.
    //
    // The decisive, label-independent signal is the HOST marker: inside the
    // container that absolute path resolves to the container's ephemeral fs, so
    // the host file never appears. If a regression retried the command through
    // runUnsandboxed() after the nonzero exit, the SAME command would run directly
    // on the host and create the marker — caught here. On a runner without a
    // daemon the docker CLI fails at launch; the invariants (error surfaced, no
    // host marker) still hold.
    const hostMarker = join(tmpdir(), `agav-dockerfail-HOST-${process.pid}-${Date.now()}.txt`);
    if (existsSync(hostMarker)) rmSync(hostMarker, { force: true });
    try {
      const result = await runInSandbox({
        // Write to the host-absolute marker path, then fail. Inside the container
        // this writes the container fs, not the host; an unsandboxed fallback would
        // write the real host file.
        command: `printf fallback-ran > ${JSON.stringify(hostMarker)}; exit 7`,
        cwd: tmpdir(),
        timeout: 8000,
        maxBuffer: 1 << 16,
        forceBackend: "docker",
      });
      expect(result.error).not.toBeNull();        // non-zero exit surfaced, not swallowed
      expect(result.backend).toBe("docker");       // selected backend retained
      // The clinching proof: the command never executed on the host. A silent
      // unsandboxed retry after the nonzero exit would have created this file.
      expect(existsSync(hostMarker)).toBe(false);
    } finally {
      if (existsSync(hostMarker)) rmSync(hostMarker, { force: true });
    }
  }, 20_000);
});
