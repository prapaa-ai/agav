import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The embedded Bun runtime ships inside every release binary and is invisible to
// pnpm audit / the SBOM / Semgrep, so check-bun-advisories.mjs is the only gate
// mapping the pinned Bun version to known advisories. These tests pin its
// fail-closed contract: the real repo passes, and every malformed or vulnerable
// input is a hard error.

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/check-bun-advisories.mjs");
const workflowPaths = [
  ".github/workflows/pr-checks.yml",
  ".github/workflows/postmerge-ci.yml",
  ".github/workflows/release.yml",
];

describe("check-bun-advisories", () => {
  it("passes against the real repository pins", () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("meets the advisory floor");
  });

  it("keeps the runtime-audit gate always-on and in the required set", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/pr-checks.yml"), "utf8"));
    const audit = workflow.jobs["runtime-audit"];
    expect(audit).toBeDefined();
    // No `needs`/`if` gating: a new advisory can raise the floor with no file
    // change in the PR, so this must run unconditionally.
    expect(audit.needs).toBeUndefined();
    expect(audit.if).toBeUndefined();
    expect(JSON.stringify(audit.steps)).toContain("check-bun-advisories.mjs");
    expect(workflow.jobs["required"].needs).toContain("runtime-audit");
  });

  it("keeps the embedded-runtime and dependency scans fail-closed", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/postmerge-ci.yml"), "utf8"));
    const findTrivy = (job: string) =>
      workflow.jobs[job].steps.find((step: any) => String(step.uses ?? "").startsWith("aquasecurity/trivy-action"));

    const binaryScan = findTrivy("binary-smoke");
    expect(binaryScan.with["exit-code"]).toBe("1");
    expect(binaryScan.with["scan-type"]).toBe("rootfs");
    expect(binaryScan.with.severity).toBe("HIGH,CRITICAL");

    const fsScan = findTrivy("dependency-fs-scan");
    expect(fsScan.with["exit-code"]).toBe("1");
    expect(fsScan.with.severity).toBe("HIGH,CRITICAL");

    // The old report-only base-image scan must be gone.
    expect(workflow.jobs["container-scan"]).toBeUndefined();
    expect(JSON.stringify(workflow)).not.toContain("node:22-slim");
  });

  it("gates the release build matrix on the advisory floor", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
    const steps = workflow.jobs["check-version"].steps;
    const gate = steps.find((step: any) => step.run === "node scripts/check-bun-advisories.mjs");
    expect(gate).toBeDefined();
    // Unconditional: no `if` that could skip it on a release push.
    expect(gate.if).toBeUndefined();
    // The build matrix depends on check-version, so a failed gate blocks builds.
    expect(workflow.jobs["build-binaries"].needs).toBe("check-version");
  });

  it("keeps dependency-audit blocking, not warn-only", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/pr-checks.yml"), "utf8"));
    const run = workflow.jobs["dependency-audit"].steps.map((step: any) => step.run ?? "").join("\n");
    expect(run).toContain("pnpm audit --prod --audit-level high");
    expect(run).not.toContain("::warning::Dependency vulnerabilities found");
  });

  describe("fail-closed inputs", () => {
    let repo: string;
    const run = () => spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });

    beforeEach(() => {
      // The script resolves its root from cwd, so an isolated copy of the two
      // inputs it reads (.bun-version and the pinned workflows) is enough; it is
      // still run from the real script path.
      repo = mkdtempSync(join(tmpdir(), "agav-bun-advisory-"));
      cpSync(join(root, ".bun-version"), join(repo, ".bun-version"));
      for (const path of workflowPaths) {
        cpSync(join(root, path), join(repo, path), { recursive: true });
      }
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("rejects a pin below the advisory floor", () => {
      writeFileSync(join(repo, ".bun-version"), "1.3.14\n");
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("below the advisory floor");
      expect(result.stderr).toContain("CVE-2026-111497");
    });

    it("rejects a workflow pin that drifts from .bun-version", () => {
      const path = join(repo, ".github/workflows/release.yml");
      writeFileSync(path, readFileSync(path, "utf8").replace('bun-version: "1.4.4"', 'bun-version: "1.4.5"'));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Keep every workflow pin equal to .bun-version");
    });

    it("rejects setup-bun usage without a pin", () => {
      const path = join(repo, ".github/workflows/release.yml");
      writeFileSync(path, readFileSync(path, "utf8").replace(/\n\s*bun-version: "1\.4\.4"/, ""));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pins no bun-version");
    });

    it.each([
      ["two versions", "1.4.4\n1.4.5\n"],
      ["non-numeric", "latest\n"],
      ["empty", "\n"],
    ])("rejects a malformed .bun-version (%s)", (_label, content) => {
      writeFileSync(join(repo, ".bun-version"), content);
      expect(run().status).toBe(1);
    });
  });
});
