import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BundledVoiceRuntime } from "../voice/bundled-runtime.js";

const state = vi.hoisted(() => ({ root: "", bundle: null as BundledVoiceRuntime | null, syncError: "", probe: "0", probeError: false, probes: [] as string[] }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: async (path: string) => {
      state.probes.push(path);
      if (state.probeError) throw new Error("probe failed");
      return { stdout: state.probe, stderr: "" };
    },
  });
  return { execFile };
});
vi.mock("../config/config.js", () => ({
  getAgavDir: () => state.root,
  expandHome: (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
}));
vi.mock("../voice/bundled-runtime.js", () => ({ get BUNDLED_VOICE_RUNTIME() { return state.bundle; } }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (state.syncError) vi.spyOn(file, "sync").mockRejectedValue(Object.assign(new Error("fixture failure"), { code: state.syncError }));
      return file;
    }),
  };
});
import { VERSION } from "../version.js";
import { ensureVoiceRuntime, getVoiceRuntimePath } from "../utils/voice-runtime.js";

const bytes = Buffer.from("synthetic native helper fixture; never executed");
const digest = createHash("sha256").update(bytes).digest("hex");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
const originalOverride = process.env.AGAV_VOICE_HELPER_BIN;
let controller: AbortController;
let fetchMock: ReturnType<typeof vi.fn>;
function host(os: string, cpu: string) {
  Object.defineProperty(process, "platform", { value: os, configurable: true });
  Object.defineProperty(process, "arch", { value: cpu, configurable: true });
}
async function cache(data = bytes, mode = 0o700) {
  const path = getVoiceRuntimePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, data, { mode });
  return path;
}
async function noStaging() {
  const entries = await fs.readdir(dirname(getVoiceRuntimePath())).catch(() => []);
  expect(entries.filter(name => name.startsWith(".voice-runtime-"))).toEqual([]);
}

beforeEach(async () => {
  state.root = await fs.mkdtemp(join(tmpdir(), "agav-runtime-test-"));
  state.bundle = { target: "darwin-arm64", size: bytes.length, sha256: digest, gzipBase64: gzipSync(bytes).toString("base64"), licenses: { whisper: "whisper license", miniaudio: "miniaudio license" } };
  state.syncError = "";
  state.probe = "0";
  state.probeError = false;
  state.probes = [];
  controller = new AbortController();
  delete process.env.AGAV_VOICE_HELPER_BIN;
  host("darwin", "arm64");
  fetchMock = vi.fn(() => { throw new Error("Runtime must never fetch"); });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear();
});
afterEach(async () => {
  expect(fetchMock).not.toHaveBeenCalled();
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", arch);
  if (originalOverride === undefined) delete process.env.AGAV_VOICE_HELPER_BIN;
  else process.env.AGAV_VOICE_HELPER_BIN = originalOverride;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(state.root, { recursive: true, force: true });
});

describe("bundled voice runtime", () => {
  it.each(["1", "0", "invalid", "error"])("gates optimized extraction through the baseline probe: %s", async probe => {
    host("linux", "x64");
    state.bundle!.target = "linux-x64";
    const optimized = Buffer.from("optimized executable fixture");
    state.bundle!.avx2 = { ...state.bundle!, size: optimized.length, sha256: createHash("sha256").update(optimized).digest("hex"), gzipBase64: gzipSync(optimized).toString("base64") };
    state.probe = probe;
    state.probeError = probe === "error";
    const baseline = getVoiceRuntimePath();
    expect(await ensureVoiceRuntime(controller.signal)).toBe(probe === "1" ? `${baseline}.avx2` : baseline);
    expect(state.probes).toEqual([baseline]);
    expect(await fs.readFile(baseline)).toEqual(bytes);
    if (probe === "1") {
      expect(await fs.readFile(`${baseline}.avx2`)).toEqual(optimized);
      expect(getVoiceRuntimePath()).toBe(`${baseline}.avx2`);
      await fs.writeFile(`${baseline}.avx2`, "corrupt");
      expect(await ensureVoiceRuntime(controller.signal)).toBe(`${baseline}.avx2`);
      expect(await fs.readFile(`${baseline}.avx2`)).toEqual(optimized);
    } else {
      await expect(fs.stat(`${baseline}.avx2`)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await noStaging();
  });
  it("keeps the executable extension on optimized Windows helpers", async () => {
    host("win32", "x64");
    state.bundle!.target = "win32-x64";
    const optimized = Buffer.from("optimized Windows executable fixture");
    state.bundle!.avx2 = { ...state.bundle!, size: optimized.length, sha256: createHash("sha256").update(optimized).digest("hex"), gzipBase64: gzipSync(optimized).toString("base64") };
    state.probe = "1";
    const baseline = getVoiceRuntimePath();
    const optimizedPath = baseline.replace(".exe", ".avx2.exe");
    expect(await ensureVoiceRuntime(controller.signal)).toBe(optimizedPath);
    expect(await fs.readFile(optimizedPath)).toEqual(optimized);
    expect(getVoiceRuntimePath()).toBe(optimizedPath);
  });
  it("forces baseline on x64 without executing the capability probe", async () => {
    host("linux", "x64"); state.bundle!.target = "linux-x64";
    state.bundle!.avx2 = { ...state.bundle! }; state.probe = "1";
    vi.stubEnv("AGAV_VOICE_CPU_BASELINE", "1");
    try {
      expect(await ensureVoiceRuntime(controller.signal)).toBe(getVoiceRuntimePath());
      expect(state.probes).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects a corrupt selected sibling without replacing the baseline", async () => {
    host("linux", "x64");
    state.bundle!.target = "linux-x64";
    state.bundle!.avx2 = { ...state.bundle!, sha256: "0".repeat(64) };
    state.probe = "1";
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow("SHA-256 mismatch");
    expect(await fs.readFile(getVoiceRuntimePath())).toEqual(bytes);
    await noStaging();
  });
  it("does not inspect an optimized bundle on ARM", async () => {
    state.bundle!.avx2 = {} as BundledVoiceRuntime;
    expect(await ensureVoiceRuntime(controller.signal)).toBe(getVoiceRuntimePath());
    expect(state.probes).toEqual([]);
  });
  it.each(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"])("preserves version-scoped %s paths and installs offline", async key => {
    const [os, cpu] = key.split("-");
    host(os!, cpu!);
    state.bundle!.target = key;
    const path = join(state.root, "voice", "runtime", VERSION, key, os === "win32" ? "agav-voice.exe" : "agav-voice");
    expect(getVoiceRuntimePath()).toBe(path);
    expect(await ensureVoiceRuntime(controller.signal)).toBe(path);
    expect(await fs.readFile(path)).toEqual(bytes);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(`${path}.LICENSE.whisper.cpp.txt`, "utf8")).toBe("whisper license");
    expect(await fs.readFile(`${path}.LICENSE.miniaudio.txt`, "utf8")).toBe("miniaudio license");
    await noStaging();
  });
  it.each([["win32", "arm64"], ["linux", "ia32"], ["freebsd", "x64"]])("rejects unsupported %s-%s", async (os, cpu) => {
    host(os!, cpu!);
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow("not supported");
  });
  it("expands only leading home in an override", () => {
    process.env.AGAV_VOICE_HELPER_BIN = "~/native/agav-voice";
    expect(getVoiceRuntimePath()).toBe(join(homedir(), "native/agav-voice"));
    process.env.AGAV_VOICE_HELPER_BIN = "relative/~/helper";
    expect(getVoiceRuntimePath()).toBe("relative/~/helper");
  });
  it("uses an explicit executable on an unsupported host without inspecting the bundle or executing", async () => {
    const path = join(state.root, "local-helper");
    await fs.writeFile(path, "not executable code", { mode: 0o700 });
    host("freebsd", "x64");
    state.bundle = null;
    process.env.AGAV_VOICE_HELPER_BIN = path;
    expect(await ensureVoiceRuntime(controller.signal)).toBe(path);
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
  });
  it.each(["", "missing", "directory", "not-executable", "nul\0file"])("rejects invalid override %j", async kind => {
    const path = kind ? join(state.root, kind) : "";
    if (kind === "directory") await fs.mkdir(path);
    if (kind === "not-executable") await fs.writeFile(path, "fixture", { mode: 0o600 });
    process.env.AGAV_VOICE_HELPER_BIN = path;
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow("AGAV_VOICE_HELPER_BIN");
  });
  it("rejects Windows shell wrappers but accepts a native extension", async () => {
    host("win32", "x64");
    const path = join(state.root, "helper.cmd");
    await fs.writeFile(path, bytes);
    process.env.AGAV_VOICE_HELPER_BIN = path;
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow("AGAV_VOICE_HELPER_BIN");
    await fs.rename(path, `${path}.exe`);
    process.env.AGAV_VOICE_HELPER_BIN = `${path}.exe`;
    expect(await ensureVoiceRuntime(controller.signal)).toBe(`${path}.exe`);
  });
  it("explains how to build a missing developer bundle, even if a cache exists", async () => {
    await cache();
    state.bundle = null;
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow("pnpm build:binary --voice");
  });
  it("rejects target mismatch before touching the cache", async () => {
    await cache();
    state.bundle!.target = "linux-x64";
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow("target mismatch");
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 128 * 1024 * 1024 + 1, "42"])("rejects invalid size %j", async size => {
    state.bundle!.size = size as number;
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow("Invalid bundled");
  });
  it.each(["hash", "base64", "licenses", "gzip", "size", "checksum"])("rejects bad %s and preserves existing cache", async kind => {
    const old = Buffer.alloc(bytes.length, 9);
    const path = await cache(old);
    if (kind === "hash") state.bundle!.sha256 = "bad";
    if (kind === "base64") state.bundle!.gzipBase64 = "not!base64";
    if (kind === "licenses") state.bundle!.licenses.whisper = "";
    if (kind === "gzip") state.bundle!.gzipBase64 = Buffer.from("not gzip").toString("base64");
    if (kind === "size") state.bundle!.size++;
    if (kind === "checksum") state.bundle!.sha256 = "0".repeat(64);
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow();
    expect(await fs.readFile(path)).toEqual(old);
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
    await noStaging();
  });
  it("rehashes cached bytes every time and repairs corruption atomically", async () => {
    const path = await ensureVoiceRuntime(controller.signal);
    const info = await fs.stat(path);
    await ensureVoiceRuntime(controller.signal);
    expect((await fs.stat(path)).ino).toBe(info.ino);
    await fs.writeFile(path, Buffer.alloc(bytes.length, 7));
    await ensureVoiceRuntime(controller.signal);
    expect(await fs.readFile(path)).toEqual(bytes);
    await noStaging();
  });
  it.each(["truncated", "oversized", "not-executable"])("repairs %s cache", async kind => {
    const path = await cache(kind === "truncated" ? Buffer.from("short") : kind === "oversized" ? Buffer.alloc(bytes.length + 1) : bytes, kind === "not-executable" ? 0o600 : 0o700);
    await ensureVoiceRuntime(controller.signal);
    expect(await fs.readFile(path)).toEqual(bytes);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
  });
  it("rejects cached symlinks rather than following or overwriting them", async () => {
    const other = join(state.root, "other");
    await fs.writeFile(other, bytes, { mode: 0o700 });
    const path = getVoiceRuntimePath();
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.symlink(other, path);
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow("symlink");
    expect(await fs.readlink(path)).toBe(other);
  });
  it("restores missing licenses on a valid cache hit", async () => {
    const path = await cache();
    await ensureVoiceRuntime(controller.signal);
    expect(await fs.readFile(`${path}.LICENSE.miniaudio.txt`, "utf8")).toBe("miniaudio license");
  });
  it("supports concurrent extraction of identical bytes with no leftover stages", async () => {
    // Stagger entry through Vitest's dynamic-import mock boundary while filesystem installs overlap.
    const jobs: Promise<string>[] = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(ensureVoiceRuntime(controller.signal));
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const results = await Promise.allSettled(jobs);
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    const paths = results.map(result => (result as PromiseFulfilledResult<string>).value);
    expect(new Set(paths).size).toBe(1);
    expect(await fs.readFile(paths[0]!)).toEqual(bytes);
    await noStaging();
  });
  it("checks pre-aborted requests before any work", async () => {
    controller.abort();
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
  });
  it("checks cancellation after staged I/O and cleans without publishing", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      controller.abort();
      return file;
    });
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
    await noStaging();
  });
  it.each([["ENOSPC", "insufficient disk space"], ["EACCES", "permission denied"], ["EROFS", "read-only"]])("reports %s and cleans staging", async (code, text) => {
    state.syncError = code!;
    await expect(ensureVoiceRuntime(controller.signal)).rejects.toThrow(text);
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
    await noStaging();
  });
});
