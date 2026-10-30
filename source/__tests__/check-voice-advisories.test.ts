import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The native voice helper statically links whisper.cpp (+ bundled ggml) and
// miniaudio into the voice-enabled binary; pnpm audit / SBOM / Semgrep / the Bun
// gate never see them. check-voice-advisories.mjs is the only gate mapping the
// CMake-pinned versions to known advisories. These tests pin its fail-closed
// contract and its wiring into CI and the live monitor.

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/check-voice-advisories.mjs");
const CMAKE = "native/voice/CMakeLists.txt";

describe("check-voice-advisories", () => {
  it("passes against the real repository pins", () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("meet their advisory floors");
    expect(result.stdout).toMatch(/whisper\.cpp@\d+\.\d+\.\d+/);
    expect(result.stdout).toMatch(/miniaudio@\d+\.\d+\.\d+/);
  });

  it("emits a machine-readable inventory", () => {
    const result = spawnSync(process.execPath, [script, "--inventory-json"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    const inv = JSON.parse(result.stdout);
    expect(inv["whisper.cpp"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(inv["miniaudio"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  describe("fail-closed inputs", () => {
    let repo: string;
    const run = () => spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });

    beforeEach(() => {
      // The script resolves its root from cwd and reads only CMakeLists.txt.
      repo = mkdtempSync(join(tmpdir(), "agav-voice-advisory-"));
      mkdirSync(dirname(join(repo, CMAKE)), { recursive: true });
      cpSync(join(root, CMAKE), join(repo, CMAKE));
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("rejects whisper.cpp pinned below its advisory floor", () => {
      const path = join(repo, CMAKE);
      writeFileSync(path, readFileSync(path, "utf8").replace("refs/tags/v1.7.6", "refs/tags/v1.7.5"));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("below its advisory floor");
      expect(result.stderr).toContain("whisper.cpp");
    });

    it("rejects miniaudio pinned below its advisory floor", () => {
      const path = join(repo, CMAKE);
      writeFileSync(path, readFileSync(path, "utf8").replace("refs/tags/0.11.22", "refs/tags/0.11.21"));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("below its advisory floor");
      expect(result.stderr).toContain("miniaudio");
    });

    it("fails closed when a component's FetchContent declare is removed", () => {
      // Drop the whisper declare's tag URL so the version cannot be read: the gate
      // must refuse rather than pass blind.
      const path = join(repo, CMAKE);
      writeFileSync(path, readFileSync(path, "utf8").replace(/FetchContent_Declare\(whisper[\s\S]*?refs\/tags\/v1\.7\.6/, "FetchContent_Declare(whisper"));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Could not read the pinned whisper version");
    });

    it("fails closed when CMakeLists.txt is missing", () => {
      rmSync(join(repo, CMAKE));
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Cannot read .*CMakeLists\.txt/);
    });
  });
});

describe("voice advisory gate wiring", () => {
  const wf = (name: string) => parse(readFileSync(join(root, ".github/workflows", name), "utf8")) as {
    jobs: Record<string, { steps?: { run?: string }[]; needs?: string[]; if?: string }>;
  };
  const hasVoiceGate = (steps?: { run?: string }[]) =>
    (steps ?? []).some((s) => String(s.run ?? "").includes("check-voice-advisories.mjs"));

  it("runs in the PR runtime-audit job (always-on, in the required set)", () => {
    const w = wf("pr-checks.yml");
    expect(hasVoiceGate(w.jobs["runtime-audit"]?.steps)).toBe(true);
    // runtime-audit is unconditional (a new advisory can land with no file change).
    expect(w.jobs["runtime-audit"]?.needs).toBeUndefined();
    expect(w.jobs["runtime-audit"]?.if).toBeUndefined();
    expect(w.jobs["required"]?.needs).toContain("runtime-audit");
  });

  it("runs before compiling the binary in postmerge binary-smoke", () => {
    expect(hasVoiceGate(wf("postmerge-ci.yml").jobs["binary-smoke"]?.steps)).toBe(true);
  });

  it("blocks the release in the check-version prerequisite", () => {
    const w = wf("release.yml");
    expect(hasVoiceGate(w.jobs["check-version"]?.steps)).toBe(true);
    expect(w.jobs["build-binaries"]?.needs).toContain("check-version");
  });
});

describe("live monitor covers the voice components", () => {
  it("records whisper.cpp and miniaudio sources in the review policy", () => {
    const policy = JSON.parse(readFileSync(join(root, "security/runtime-review.json"), "utf8"));
    expect(policy.sources["whisper.cpp"]).toBe("ggml-org/whisper.cpp");
    expect(policy.sources["miniaudio"]).toBe("mackron/miniaudio");
  });

  it("the monitor's expected-source set matches the policy (so validateReview passes)", () => {
    // runtime-monitor.mjs enforces that the policy sources exactly equal its
    // EXPECTED_SOURCES; a drift between the two would fail every review. Assert the
    // two voice entries are present in the script's source table.
    const monitor = readFileSync(join(root, "scripts/runtime-monitor.mjs"), "utf8");
    expect(monitor).toContain('"whisper.cpp": "ggml-org/whisper.cpp"');
    expect(monitor).toContain('miniaudio: "mackron/miniaudio"');
  });

  it("the offline runtime check merges the voice inventory so the live monitor has a version per source", () => {
    const checker = readFileSync(join(root, "scripts/check-runtime-security.mjs"), "utf8");
    expect(checker).toContain("check-voice-advisories.mjs");
  });
});
