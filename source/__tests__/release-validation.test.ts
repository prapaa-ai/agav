import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
const jobs = workflow.jobs;
const build = jobs["build-binaries"];
const smoke = build.steps.find((step: any) => step.name === "Smoke test release binary");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("release validation gates", () => {
  it("requires full same-SHA validation and native builds as well as the existing gates", () => {
    expect(jobs.release.needs).toEqual(expect.arrayContaining([
      "check-version", "dependency-audit", "validation", "installer-windows", "build-binaries",
    ]));
    expect(jobs.release.if).toBeUndefined(); // default success(), never always()
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(jobs.release.permissions).toEqual({ contents: "write" });
    for (const name of ["validation", "installer-windows"]) {
      const job = jobs[name];
      expect(job.needs).toBe("check-version");
      expect(job.if).toBe("needs.check-version.outputs.changed == 'true'");
      expect(job["continue-on-error"]).toBeUndefined();
      expect(job.permissions ?? workflow.permissions).toEqual({ contents: "read" });
      const checkout = job.steps.find((step: any) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
      for (const step of job.steps) {
        expect(step.if).toBeUndefined();
        expect(step["continue-on-error"]).toBeUndefined();
      }
    }
    // Default push checkout is the event SHA; no moving branch overrides.
    const checkout = build.steps.find((step: any) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout.with.ref ?? "${{ github.sha }}").toBe("${{ github.sha }}");
    const publish = jobs.release.steps.find((step: any) => step.name === "Create GitHub Release");
    expect(publish.with.target_commitish).toBe("${{ github.sha }}");
  });

  it("installs frozen dependencies before typecheck, build, and the unfiltered test suite", () => {
    const job = jobs.validation;
    expect(job["runs-on"]).toBe("ubuntu-latest");
    const pnpm = job.steps.find((step: any) => step.uses?.startsWith("pnpm/action-setup@"));
    expect(String(pnpm.with.version)).toMatch(/^9\.\d+\.\d+$/);
    const commands = job.steps.filter((step: any) => step.run).map((step: any) => step.run);
    expect(commands.slice(0, 4)).toEqual([
      "pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm build", "pnpm exec vitest run",
    ]);
    expect(commands.join("\n")).not.toContain("passWithNoTests");
    expect(commands[4]).toContain("set -euo pipefail");
    expect(commands[4]).toContain("sh scripts/tests/install-sh.test.sh");
    expect(commands[4]).toContain("sh scripts/tests/install-sh-path.test.sh");
  });

  it("runs Windows installer regressions on both native PowerShell hosts and preserves failures", () => {
    const job = jobs["installer-windows"];
    expect(job["runs-on"]).toBe("windows-latest");
    for (const shell of ["powershell", "pwsh"]) {
      const step = job.steps.find((step: any) => step.shell === shell);
      expect(step.run).toContain('"install-ps1.test.ps1", "install-ps1-path.test.ps1"');
      expect(step.run).toContain(`& ${shell} -NoProfile -File`);
      expect(step.run).toContain("if ($LASTEXITCODE -ne 0) { $Fail = 1 }");
      expect(step.run).toContain("exit $Fail");
    }
    expect(job.steps.find((step: any) => step.shell === "pwsh").run).toContain("install-ps1-lint.test.ps1");
  });

  it("smokes every exact native artifact after signing but before compression, checksums, and upload", () => {
    expect(Object.fromEntries(build.strategy.matrix.include.map((entry: any) => [entry.target, entry.os]))).toEqual({
      "darwin-arm64": "macos-latest", "darwin-x64": "macos-15-intel",
      "linux-x64": "ubuntu-latest", "linux-arm64": "ubuntu-24.04-arm",
      "windows-x64": "windows-latest", "windows-x64-baseline": "windows-latest",
    });
    expect(build["runs-on"]).toBe("${{ matrix.os }}");
    expect(build.defaults.run.shell).toBe("bash");
    expect(build["continue-on-error"]).toBeUndefined();
    expect(smoke).toBeDefined();
    expect(smoke.if).toBeUndefined();
    expect(smoke["continue-on-error"]).toBeUndefined();
    expect(smoke["timeout-minutes"]).toBeGreaterThan(0);
    expect(smoke.run).toContain("set -euo pipefail");
    expect(smoke.run).toContain("require('./package.json').version");
    expect(smoke.env.BINARY).toBe("./dist/agav-${{ matrix.target }}${{ matrix.ext }}");
    const index = build.steps.indexOf(smoke);
    for (const name of ["Build binary", "Verify the binary embeds the pinned Bun runtime", "Sign binary (macOS)"]) {
      expect(build.steps.findIndex((step: any) => step.name === name)).toBeLessThan(index);
    }
    for (const name of ["Compress binary", "Generate checksums"]) {
      expect(build.steps.findIndex((step: any) => step.name === name)).toBeGreaterThan(index);
    }
    const upload = build.steps.find((step: any) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(build.steps.indexOf(upload)).toBeGreaterThan(index);
    expect(upload.if).toBeUndefined();
    expect(upload.with.path.split("\n")).toContain(smoke.env.BINARY.slice(2));
  });
});

// Execute the actual workflow shell with an isolated artifact, not a duplicate
// implementation. Native Windows binaries themselves are exercised by CI.
describe.skipIf(process.platform === "win32")("release artifact smoke failure propagation", () => {
  function run(mode = "ok", suffix = "", version = "0.2.5-beta.3", output = version) {
    const dir = mkdtempSync(join(tmpdir(), "agav release smoke "));
    roots.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
    const binary = join(dir, `agav${suffix}`);
    writeFileSync(binary, `#!/bin/sh
case "$1" in
  --version)
    printf '%s\\n' "$SMOKE_VERSION"
    if [ "$SMOKE_MODE" = version-failure ]; then exit 7; fi
    ;;
  --help)
    if [ "$SMOKE_MODE" = bad-help ]; then echo unrelated; else echo 'Agav help'; fi
    if [ "$SMOKE_MODE" = help-failure ]; then exit 9; fi
    ;;
  *) exit 10 ;;
esac
`);
    chmodSync(binary, 0o755);
    if (mode === "missing") rmSync(binary);
    if (mode === "not-executable") chmodSync(binary, 0o644);
    return spawnSync("bash", ["-c", smoke.run], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, BINARY: binary, SMOKE_MODE: mode, SMOKE_VERSION: output },
    });
  }

  it.each(["", ".exe"])("accepts matching stable, beta and CRLF versions for artifact suffix %j", suffix => {
    for (const version of ["0.2.5", "0.2.5-beta.3"]) {
      const result = run("ok", suffix, version);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Agav help");
    }
    const result = run("ok", suffix, "0.2.5", "0.2.5\r");
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["0.2.4", "v0.2.5", "", "0.2.5 extra", "0.2.5\nextra"])("rejects mismatched version output %j", output => {
    const result = run("ok", "", "0.2.5", output);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("does not match package.json");
    expect(result.stdout).not.toContain("Agav help");
  });

  it.each(["version-failure", "help-failure", "bad-help", "missing", "not-executable"])(
    "blocks publication on %s even if a pipeline consumer succeeds", mode => {
      const result = run(mode);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
    },
  );
});
