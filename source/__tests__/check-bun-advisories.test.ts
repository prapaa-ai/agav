import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(result.stdout).toContain("vendored components OK");
  });

  it("fails closed (not a silent skip) when the yaml parser is unavailable", () => {
    // The gate parses workflow YAML with the real `yaml` parser; the workflows
    // install it before invoking the gate. If `yaml` is somehow missing, the gate
    // must refuse rather than fall back to a fragile scanner or skip validation.
    // Run a copy from a dir with NO node_modules so `yaml` cannot resolve.
    const clean = mkdtempSync(join(tmpdir(), "agav-noyaml-"));
    try {
      cpSync(join(root, "scripts/check-bun-advisories.mjs"), join(clean, "check-bun-advisories.mjs"));
      cpSync(join(root, ".bun-version"), join(clean, ".bun-version"));
      for (const path of workflowPaths) cpSync(join(root, path), join(clean, path), { recursive: true });
      const result = spawnSync(process.execPath, [join(clean, "check-bun-advisories.mjs")], { cwd: clean, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("`yaml` package is required");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
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

  it("verifies the embedded runtime (no unscannable Trivy SBOM) and keeps the dep scan fail-closed", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/postmerge-ci.yml"), "utf8"));
    const steps = (job: string) => workflow.jobs[job].steps as any[];

    // The pre-build advisory gate covers the runtime AND its vendored C libs.
    const advisoryGate = steps("binary-smoke").find((step: any) =>
      String(step.run ?? "").includes("check-bun-advisories.mjs"));
    expect(advisoryGate).toBeDefined();
    // The artifact is verified to embed the pinned Bun; no SBOM, no binary Trivy.
    const verifyStep = steps("binary-smoke").find((step: any) =>
      String(step.run ?? "").includes("verify-embedded-runtime.mjs"));
    expect(verifyStep).toBeDefined();
    const binaryTrivy = steps("binary-smoke").find((step: any) =>
      String(step.uses ?? "").startsWith("aquasecurity/trivy-action"));
    expect(binaryTrivy).toBeUndefined();
    // The obsolete SBOM generator must be gone from the workflow entirely.
    expect(JSON.stringify(workflow)).not.toContain("embedded-runtime-sbom.mjs");

    // The npm dependency filesystem scan (which Trivy CAN scan) stays fail-closed.
    const fsScan = steps("dependency-fs-scan").find((step: any) =>
      String(step.uses ?? "").startsWith("aquasecurity/trivy-action"));
    expect(fsScan.with["exit-code"]).toBe("1");
    expect(fsScan.with.severity).toBe("HIGH,CRITICAL");

    // The old report-only base-image scan must be gone.
    expect(workflow.jobs["container-scan"]).toBeUndefined();
    expect(JSON.stringify(workflow)).not.toContain("node:22-slim");
  });

  it("gates release publication on a runtime verify step and a dependency audit", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
    const buildSteps = workflow.jobs["build-binaries"].steps as any[];

    // Per-artifact runtime verification before upload; no unscannable SBOM/Trivy.
    const verifyStep = buildSteps.find((step: any) => String(step.run ?? "").includes("verify-embedded-runtime.mjs"));
    expect(verifyStep).toBeDefined();
    expect(buildSteps.some((step: any) => String(step.uses ?? "").startsWith("aquasecurity/trivy-action"))).toBe(false);
    expect(JSON.stringify(workflow)).not.toContain("embedded-runtime-sbom.mjs");

    // A dependency audit of the release commit gates both build and publication.
    const audit = workflow.jobs["dependency-audit"];
    expect(audit).toBeDefined();
    expect(audit.steps.map((s: any) => s.run ?? "").join("\n")).toContain("pnpm audit --prod --audit-level high");
    expect(workflow.jobs["build-binaries"].needs).toContain("dependency-audit");
    expect(workflow.jobs["release"].needs).toContain("dependency-audit");
    expect(workflow.jobs["release"].needs).toContain("build-binaries");
  });

  it("gates the release build matrix on the advisory floor", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
    const steps = workflow.jobs["check-version"].steps;
    const gate = steps.find((step: any) => step.run === "node scripts/check-bun-advisories.mjs");
    expect(gate).toBeDefined();
    // Unconditional: no `if` that could skip it on a release push.
    expect(gate.if).toBeUndefined();
    // The build matrix depends on check-version, so a failed gate blocks builds.
    expect(workflow.jobs["build-binaries"].needs).toContain("check-version");
  });

  it("keeps dependency-audit blocking, not warn-only", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/pr-checks.yml"), "utf8"));
    const run = workflow.jobs["dependency-audit"].steps.map((step: any) => step.run ?? "").join("\n");
    expect(run).toContain("pnpm audit --prod --audit-level high");
    expect(run).not.toContain("::warning::Dependency vulnerabilities found");
  });

  it("fails closed when a vendored C library is below its advisory floor", () => {
    // Patch the script's component map to a below-floor version and confirm the
    // gate rejects it: a Bun that meets the top-level floor can still bundle a
    // vulnerable statically linked library.
    const clean = mkdtempSync(join(tmpdir(), "agav-component-"));
    try {
      const patched = readFileSync(join(root, "scripts/check-bun-advisories.mjs"), "utf8")
        .replace('{ name: "c-ares", current: "1.34.8", floor: "1.34.8" }', '{ name: "c-ares", current: "1.0.0", floor: "1.34.8" }');
      cpSync(join(root, ".bun-version"), join(clean, ".bun-version"));
      for (const path of workflowPaths) cpSync(join(root, path), join(clean, path), { recursive: true });
      writeFileSync(join(clean, "check-bun-advisories.mjs"), patched);
      // The gate needs the real yaml parser; make the repo's install resolvable.
      symlinkSync(join(root, "node_modules"), join(clean, "node_modules"));
      const result = spawnSync(process.execPath, [join(clean, "check-bun-advisories.mjs")], { cwd: clean, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("below its advisory floor");
      expect(result.stderr).toContain("c-ares");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it("fails closed when a Bun version has no vendored-component map", () => {
    const clean = mkdtempSync(join(tmpdir(), "agav-nomap-"));
    try {
      cpSync(join(root, "scripts/check-bun-advisories.mjs"), join(clean, "check-bun-advisories.mjs"));
      for (const path of workflowPaths) cpSync(join(root, path), join(clean, path), { recursive: true });
      symlinkSync(join(root, "node_modules"), join(clean, "node_modules"));
      // A pin with no component map; also drop the workflow pins so the floor
      // check is reached only after a version the map does not cover.
      writeFileSync(join(clean, ".bun-version"), "99.0.0\n");
      const result = spawnSync(process.execPath, [join(clean, "check-bun-advisories.mjs")], { cwd: clean, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/No vendored-component map|pins bun-version/);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
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
      expect(result.stderr).toContain("Keep every oven-sh/setup-bun pin equal to .bun-version");
    });

    it("rejects setup-bun usage without a pin", () => {
      const path = join(repo, ".github/workflows/release.yml");
      writeFileSync(path, readFileSync(path, "utf8").replace(/\n\s*bun-version: "1\.4\.4"/, ""));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pins no with.bun-version");
    });

    it("rejects a commented-out pin (parses YAML, not raw text)", () => {
      const path = join(repo, ".github/workflows/release.yml");
      writeFileSync(path, readFileSync(path, "utf8").replace('bun-version: "1.4.4"', '# bun-version: "1.4.4"'));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pins no with.bun-version");
    });

    it("rejects a second setup-bun step left unpinned", () => {
      const path = join(repo, ".github/workflows/postmerge-ci.yml");
      writeFileSync(path, readFileSync(path, "utf8") +
        "\n  extra-unpinned:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n");
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pins no with.bun-version");
    });

    it("rejects bun-version placed under env: instead of with:", () => {
      const path = join(repo, ".github/workflows/release.yml");
      // setup-bun only reads with.bun-version; a pin under env: is no pin.
      writeFileSync(path, readFileSync(path, "utf8").replace(
        '      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.4.4"',
        '      - uses: oven-sh/setup-bun@v2\n        env:\n          bun-version: "1.4.4"'));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pins no with.bun-version");
    });

    it("rejects a quoted uses: key that hides a vulnerable pin", () => {
      const path = join(repo, ".github/workflows/release.yml");
      writeFileSync(path, readFileSync(path, "utf8").replace(
        '      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.4.4"',
        '      - "uses": oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.3.14"'));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pins bun-version 1.3.14");
    });

    it("rejects a vulnerable pin written as a flow mapping", () => {
      const path = join(repo, ".github/workflows/release.yml");
      writeFileSync(path, readFileSync(path, "utf8").replace(
        '      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.4.4"',
        '      - { uses: oven-sh/setup-bun@v2, with: { bun-version: "1.3.14" } }'));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pins bun-version 1.3.14");
    });

    it("does not treat a bun-version inside a block scalar as a pin", () => {
      // YAML text that merely contains `with:\n  bun-version:` inside an env
      // block scalar is not an action input; the step then pins nothing.
      const path = join(repo, ".github/workflows/release.yml");
      writeFileSync(path, readFileSync(path, "utf8").replace(
        '      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.4.4"',
        '      - uses: oven-sh/setup-bun@v2\n        env:\n          NOTES: |\n            with:\n              bun-version: "1.4.4"'));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pins no with.bun-version");
    });

    it.each([
      ["inline comment", 'bun-version: "1.4.4" # security pin'],
      ["single quotes", "bun-version: '1.4.4'"],
      ["comment after with:", "with: # runtime pin\n          bun-version: \"1.4.4\""],
    ])("accepts a valid pin with %s", (_label, replacement) => {
      const path = join(repo, ".github/workflows/release.yml");
      const source = readFileSync(path, "utf8");
      const updated = _label === "comment after with:"
        ? source.replace('with:\n          bun-version: "1.4.4"', replacement)
        : source.replace('bun-version: "1.4.4"', replacement);
      writeFileSync(path, updated);
      expect(run().status).toBe(0);
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
