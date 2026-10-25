import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The embedded-runtime SBOM generator is the coverage proof for Agav's compiled
// binaries: a generic binary scan cannot see Bun's statically linked C libraries,
// so CI instead verifies the embedded Bun version and emits an explicit SBOM to
// scan. These tests pin its fail-closed contract against synthetic binaries.

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/embedded-runtime-sbom.mjs");
const PINNED = readFileSync(join(root, ".bun-version"), "utf8").trim();

describe("embedded-runtime-sbom", () => {
  let repo: string;
  const bin = () => join(repo, "fake-binary");
  const out = () => join(repo, "sbom.cdx.json");
  const run = () => spawnSync(process.execPath, [script, bin(), out()], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "agav-sbom-"));
    cpSync(join(root, "scripts/embedded-runtime-sbom.mjs"), join(repo, "scripts/embedded-runtime-sbom.mjs"));
    cpSync(join(root, ".bun-version"), join(repo, ".bun-version"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // The script resolves .bun-version and its component map from cwd, so it must
  // run from the real repo root for the happy path (its map covers the real pin).
  const runFromRoot = (binary: string, output: string) =>
    spawnSync(process.execPath, [join(root, "scripts/embedded-runtime-sbom.mjs"), binary, output], { cwd: root, encoding: "utf8" });

  it("emits a CycloneDX SBOM when the binary embeds the pinned Bun marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "agav-sbom-ok-"));
    try {
      const binary = join(dir, "agav");
      const output = join(dir, "sbom.cdx.json");
      // A minimal synthetic binary carrying the distinctive runtime marker.
      writeFileSync(binary, `app bytes ... bun-v${PINNED} ... more bytes`);
      const result = runFromRoot(binary, output);
      expect(result.status).toBe(0);
      const sbom = JSON.parse(readFileSync(output, "utf8"));
      expect(sbom.bomFormat).toBe("CycloneDX");
      // The runtime and its Brotli component must be present for Trivy to scan.
      const names = sbom.components.map((c: any) => c.name);
      expect(names).toContain("bun");
      expect(names).toContain("brotli");
      expect(sbom.components.every((c: any) => typeof c.purl === "string" && c.purl.length > 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the binary lacks the pinned Bun marker", () => {
    writeFileSync(bin(), "a binary with no bun marker at all");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not embed the pinned Bun runtime marker");
  });

  it("fails closed when the binary embeds a different Bun version", () => {
    writeFileSync(bin(), "bun-v0.0.1 wrong runtime");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not embed the pinned Bun runtime marker");
  });

  it("fails closed on conflicting embedded Bun markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "agav-sbom-conflict-"));
    try {
      const binary = join(dir, "agav");
      const output = join(dir, "sbom.cdx.json");
      writeFileSync(binary, `bun-v${PINNED} ... and also bun-v9.9.9`);
      const result = runFromRoot(binary, output);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("conflicting Bun runtime markers");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when no component map exists for the pinned Bun", () => {
    writeFileSync(join(repo, ".bun-version"), "9.9.9\n");
    writeFileSync(bin(), "bun-v9.9.9 runtime");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No embedded-runtime component map for Bun 9.9.9");
  });

  it("refuses missing arguments", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });
});
