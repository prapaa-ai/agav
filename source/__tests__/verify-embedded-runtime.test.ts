import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// verify-embedded-runtime proves a compiled artifact embeds exactly the pinned
// Bun — the version whose runtime and vendored C libraries check-bun-advisories
// vetted. These tests pin its fail-closed contract against synthetic binaries.

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/verify-embedded-runtime.mjs");
const PINNED = readFileSync(join(root, ".bun-version"), "utf8").trim();

describe("verify-embedded-runtime", () => {
  let dir: string;
  const bin = () => join(dir, "agav");
  // Run from the real repo root so .bun-version resolves to the pinned version.
  const run = () => spawnSync(process.execPath, [script, bin()], { cwd: root, encoding: "utf8" });

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agav-verify-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a binary embedding the pinned Bun runtime banner", () => {
    writeFileSync(bin(), `app bytes ... Bun v${PINNED} (38afee6c8) ... more bytes`);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`embeds the pinned Bun ${PINNED}`);
  });

  it("accepts a correct runtime even when application strings mention other bun versions", () => {
    // Real compiled binaries bundle app text such as a bun compare URL
    // (bun-v1.4.3...bun-v1.4.4). Those are not runtime identity and must not
    // trigger a conflict — only the "Bun v<x.y.z> (<commit>)" banner counts.
    writeFileSync(bin(), [
      `Runtime banner: Bun v${PINNED} (38afee6c8)`,
      "Upgrade notes: https://github.com/oven-sh/bun/compare/bun-v1.4.3...bun-v1.4.4",
    ].join("\n"));
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`embeds the pinned Bun ${PINNED}`);
  });

  it("fails closed when the binary has no Bun runtime banner", () => {
    writeFileSync(bin(), "a binary with no bun runtime banner, only bun-v1.4.4 in a URL");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no Bun runtime banner");
  });

  it("fails closed when the binary embeds a different Bun version", () => {
    writeFileSync(bin(), "Bun v0.0.1 (deadbeef) wrong runtime");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not the pinned");
  });

  it("fails closed on conflicting embedded Bun runtime banners", () => {
    writeFileSync(bin(), `Bun v${PINNED} (38afee6c8) ... and also Bun v9.9.9 (abcdef123)`);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("conflicting Bun runtime banners");
  });

  it("refuses a missing argument", () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });
});
