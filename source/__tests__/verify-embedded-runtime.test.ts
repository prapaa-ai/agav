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

  it("accepts a binary embedding the pinned Bun marker", () => {
    writeFileSync(bin(), `app bytes ... bun-v${PINNED} ... more bytes`);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`embeds the pinned Bun ${PINNED}`);
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
    writeFileSync(bin(), `bun-v${PINNED} ... and also bun-v9.9.9`);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("conflicting Bun runtime markers");
  });

  it("refuses a missing argument", () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });
});
