import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const state = vi.hoisted(() => ({ home: "", bundle: null as null | { protocol: string; size: number; sha256: string; gzipBase64: string } }));

vi.mock("node:os", async (importOriginal) => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => state.home }));
vi.mock("../utils/windows-sandbox-bundle.js", () => ({
  get BUNDLED_WINDOWS_SANDBOX_HELPER() { return state.bundle; },
}));

import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "agav-windows-bundle-test-"));
state.home = root;
const bytes = Buffer.from("MZ fake agav-sandbox helper bytes");
const valid = () => ({
  protocol: "agav-sandbox 1",
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  gzipBase64: gzipSync(bytes).toString("base64"),
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("bundled Windows sandbox helper installation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    rmSync(join(root, ".agav"), { recursive: true, force: true });
  });

  it("reports unavailable and refuses when nothing is bundled", async () => {
    state.bundle = null;
    const { ensureWindowsSandboxHelper, isWindowsSandboxHelperAvailable } = await import("../utils/windows-sandbox.js");
    expect(isWindowsSandboxHelperAvailable()).toBe(false);
    expect(() => ensureWindowsSandboxHelper()).toThrow(/not available/);
  });

  it("installs verified bytes once and reuses the cached copy", async () => {
    state.bundle = valid();
    const { ensureWindowsSandboxHelper, isWindowsSandboxHelperAvailable } = await import("../utils/windows-sandbox.js");
    expect(isWindowsSandboxHelperAvailable()).toBe(true);
    const path = ensureWindowsSandboxHelper();
    expect(path.startsWith(join(root, ".agav", "sandbox", "windows"))).toBe(true);
    expect(readFileSync(path)).toEqual(bytes);
    expect(ensureWindowsSandboxHelper()).toBe(path);
  });

  it("replaces a tampered cached copy with the verified bundle", async () => {
    state.bundle = valid();
    const { ensureWindowsSandboxHelper } = await import("../utils/windows-sandbox.js");
    const path = ensureWindowsSandboxHelper();
    writeFileSync(path, Buffer.alloc(bytes.length, 0x41));
    expect(readFileSync(ensureWindowsSandboxHelper())).toEqual(bytes);
  });

  it("rejects a bundle whose payload does not match its SHA-256", async () => {
    state.bundle = { ...valid(), sha256: "0".repeat(64) };
    const { ensureWindowsSandboxHelper } = await import("../utils/windows-sandbox.js");
    expect(() => ensureWindowsSandboxHelper()).toThrow(/integrity/);
  });

  it("rejects a bundle built for a different helper protocol", async () => {
    state.bundle = { ...valid(), protocol: "agav-sandbox 2" };
    const { ensureWindowsSandboxHelper } = await import("../utils/windows-sandbox.js");
    expect(() => ensureWindowsSandboxHelper()).toThrow(/metadata/);
  });

  it("prefers an explicit helper override and validates it", async () => {
    state.bundle = valid();
    const explicit = join(root, "custom", "agav-sandbox.exe");
    mkdirSync(join(root, "custom"), { recursive: true });
    writeFileSync(explicit, "x");
    vi.stubEnv("AGAV_WINDOWS_SANDBOX_HELPER", explicit);
    const { ensureWindowsSandboxHelper } = await import("../utils/windows-sandbox.js");
    expect(ensureWindowsSandboxHelper()).toBe(explicit);
    vi.stubEnv("AGAV_WINDOWS_SANDBOX_HELPER", join(root, "custom", "missing.exe"));
    expect(() => ensureWindowsSandboxHelper()).toThrow(/Invalid AGAV_WINDOWS_SANDBOX_HELPER/);
  });
});
