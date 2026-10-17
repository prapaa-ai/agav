import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { setTimeout as realTimeout } from "node:timers";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", digest: "", hashed: 0, shortWrites: false, zeroWrite: false, syncError: false }));
vi.mock("../config/config.js", async original => ({
  ...await original<typeof import("../config/config.js")>(),
  getAgavDir: () => state.root,
}));
vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn((algorithm: string) => {
    const hash = actual.createHash(algorithm);
    const update = hash.update.bind(hash);
    const digest = hash.digest.bind(hash);
    hash.update = vi.fn((data: Uint8Array) => { state.hashed += data.byteLength; update(data); return hash; }) as typeof hash.update;
    // Keep real streamed hashing; only override the final digest for synthetic success fixtures.
    hash.digest = vi.fn((encoding: "hex") => state.digest || digest(encoding)) as unknown as typeof hash.digest;
    return hash;
  }) };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), rename: vi.fn(actual.rename), open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const write = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementation((async (buffer: Uint8Array, offset: number, length: number) => {
      if (state.zeroWrite) return { bytesWritten: 0, buffer };
      return write(buffer, offset, state.shortWrites ? Math.min(length, 65536) : length);
    }) as typeof handle.write);
    if (state.syncError) vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    return handle;
  }) };
});

import { DEFAULT_VOICE_MODEL, downloadVoiceModel, getVoiceModelPath, hasVoiceModel } from "../utils/voice-model.js";

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let controller: AbortController;
const chunk = Buffer.alloc(1024 * 1024, 42);
function response(size = DEFAULT_VOICE_MODEL.size as number, length: string | null = null): Response {
  let remaining = size;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      if (!remaining) { stream.close(); return; }
      const bytes = Math.min(remaining, chunk.length);
      remaining -= bytes;
      stream.enqueue(chunk.subarray(0, bytes));
    },
  });
  return new Response(body, { headers: length === null ? {} : { "content-length": length } });
}
async function entries(): Promise<string[]> {
  return fs.readdir(dirname(join(state.root, "voice", DEFAULT_VOICE_MODEL.filename))).catch(() => []);
}
async function sparse(path: string, size: number) {
  await fs.mkdir(dirname(path), { recursive: true });
  const file = await fs.open(path, "w");
  try { await file.truncate(size); } finally { await file.close(); }
}
function download(progress: (bytes: number) => void = vi.fn()) { return downloadVoiceModel(controller.signal, progress); }

beforeEach(async () => {
  state.root = await fs.mkdtemp(join(tmpdir(), "agav-model-test-"));
  state.digest = ""; state.hashed = 0; state.shortWrites = false; state.zeroWrite = false; state.syncError = false;
  vi.stubEnv("AGAV_VOICE_MODEL", "");
  controller = new AbortController();
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fs.rename).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await fs.rm(state.root, { recursive: true, force: true });
});

describe("voice model paths and validation", () => {
  it("exports the fixed, immutable trusted catalog", () => {
    expect(DEFAULT_VOICE_MODEL).toEqual({
      name: "Whisper base.en Q5 (English only)", filename: "ggml-base.en-q5_1.bin", size: 59721011,
      sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en-q5_1.bin",
    });
    expect(Object.isFrozen(DEFAULT_VOICE_MODEL)).toBe(true);
  });
  it("uses global state by default and expands only a leading home in overrides", () => {
    expect(getVoiceModelPath()).toBe(join(state.root, "voice", DEFAULT_VOICE_MODEL.filename));
    vi.stubEnv("AGAV_VOICE_MODEL", "~/models/local.bin");
    expect(getVoiceModelPath()).toBe(join(homedir(), "models/local.bin"));
    vi.stubEnv("AGAV_VOICE_MODEL", "models/local.bin");
    expect(getVoiceModelPath()).toBe("models/local.bin");
  });
  it.each([0, DEFAULT_VOICE_MODEL.size - 1, DEFAULT_VOICE_MODEL.size, DEFAULT_VOICE_MODEL.size + 1])("requires exact managed size %i", async size => {
    await sparse(getVoiceModelPath(), size);
    await expect(hasVoiceModel()).resolves.toBe(size === DEFAULT_VOICE_MODEL.size);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([0, 1024 ** 2 - 1, 1024 ** 2, 4 * 1024 ** 3, 4 * 1024 ** 3 + 1])("bounds explicit regular model size %i", async size => {
    vi.stubEnv("AGAV_VOICE_MODEL", join(state.root, "custom.bin"));
    await sparse(getVoiceModelPath(), size);
    await expect(hasVoiceModel()).resolves.toBe(size >= 1024 ** 2 && size <= 4 * 1024 ** 3);
  });
  it("rejects missing paths and directories, without falling back from invalid overrides", async () => {
    await sparse(getVoiceModelPath(), DEFAULT_VOICE_MODEL.size);
    vi.stubEnv("AGAV_VOICE_MODEL", join(state.root, "missing"));
    await expect(hasVoiceModel()).resolves.toBe(false);
    vi.stubEnv("AGAV_VOICE_MODEL", state.root);
    await expect(hasVoiceModel()).resolves.toBe(false);
  });
});

describe("bounded atomic voice model downloads", () => {
  it("reuses a valid managed file without network even when an override is set", async () => {
    const managed = getVoiceModelPath();
    await sparse(managed, DEFAULT_VOICE_MODEL.size);
    vi.stubEnv("AGAV_VOICE_MODEL", "https://untrusted.invalid/custom.bin");
    await expect(download()).resolves.toBe(managed);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([null, String(DEFAULT_VOICE_MODEL.size)])("streams, hashes and publishes privately with Content-Length %s", async length => {
    state.digest = DEFAULT_VOICE_MODEL.sha256;
    state.shortWrites = true;
    fetchMock.mockResolvedValue(response(DEFAULT_VOICE_MODEL.size, length));
    vi.stubEnv("AGAV_VOICE_MODEL", join(state.root, "do-not-overwrite.bin"));
    const progress = vi.fn();
    const path = await download(progress);
    expect(path).toBe(join(state.root, "voice", DEFAULT_VOICE_MODEL.filename));
    expect(fetchMock).toHaveBeenCalledWith(DEFAULT_VOICE_MODEL.url, { signal: expect.any(AbortSignal) });
    const info = await fs.stat(path);
    expect(info.size).toBe(DEFAULT_VOICE_MODEL.size);
    expect(info.mode & 0o777).toBe(0o600);
    expect(state.hashed).toBe(DEFAULT_VOICE_MODEL.size);
    expect(createHash).toHaveBeenCalledWith("sha256");
    expect(progress.mock.calls.at(-1)).toEqual([DEFAULT_VOICE_MODEL.size]);
    expect(progress.mock.calls.length).toBeLessThan(10);
    expect(await entries()).toEqual([DEFAULT_VOICE_MODEL.filename]);
    const file = await fs.open(path, "r");
    try {
      const bytes = Buffer.alloc(16);
      await file.read(bytes, 0, bytes.length, info.size - bytes.length);
      expect(bytes).toEqual(Buffer.alloc(16, 42));
    } finally { await file.close(); }
    const [source, destination] = vi.mocked(fs.rename).mock.calls[0];
    expect(dirname(dirname(String(source)))).toBe(dirname(String(destination)));
    await expect(fs.stat(process.env.AGAV_VOICE_MODEL!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["0", "59707624", "59707626", "garbage", "59721011oops"])("rejects bad Content-Length %s and cancels body", async length => {
    const reply = response(5, length);
    const cancel = vi.spyOn(reply.body!, "cancel");
    fetchMock.mockResolvedValue(reply);
    await expect(download()).rejects.toThrow(/Content-Length/);
    expect(cancel).toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });
  it.each([DEFAULT_VOICE_MODEL.size - 1, DEFAULT_VOICE_MODEL.size + 1])("rejects chunked size mismatch %i without publishing", async size => {
    fetchMock.mockResolvedValue(response(size));
    await expect(download()).rejects.toThrow(/size/);
    expect(await entries()).toEqual([]);
    expect(fs.rename).not.toHaveBeenCalled();
  });
  it("checks the real streamed SHA-256 and preserves an existing invalid destination on failure", async () => {
    const path = getVoiceModelPath();
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, "existing data");
    await expect(download()).rejects.toThrow(/SHA-256/);
    expect(state.hashed).toBe(DEFAULT_VOICE_MODEL.size);
    expect(await fs.readFile(path, "utf8")).toBe("existing data");
    expect(await entries()).toEqual([DEFAULT_VOICE_MODEL.filename]);
  });
  it.each([403, 404, 500])("cleans up HTTP %i errors", async status => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(download()).rejects.toThrow(`HTTP ${status}`);
    expect(await entries()).toEqual([]);
  });
  it("rejects missing bodies and network failures clearly", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null));
    await expect(download()).rejects.toThrow(/no body/);
    fetchMock.mockRejectedValueOnce(new TypeError("network unreachable"));
    await expect(download()).rejects.toThrow(/network unreachable/);
    expect(await entries()).toEqual([]);
  });
  it("cleans staging after a mid-stream network error", async () => {
    let pulls = 0;
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      pull(stream) {
        if (pulls++ === 0) stream.enqueue(chunk);
        else stream.error(new Error("connection reset"));
      },
    })));
    await expect(download()).rejects.toThrow(/connection reset/);
    expect(await entries()).toEqual([]);
  });
  it("cleans verified staging when atomic publication fails", async () => {
    state.digest = DEFAULT_VOICE_MODEL.sha256;
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("rename denied"), { code: "EACCES" }));
    await expect(download()).rejects.toThrow(/permission denied/);
    expect(await entries()).toEqual([]);
  });
  it("cancels before network", async () => {
    controller.abort();
    await expect(download()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });
  it("cancels during progress, cleans all temporary files and never publishes", async () => {
    const progress = vi.fn(() => controller.abort());
    await expect(download(progress)).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(await entries()).toEqual([]);
  });
  it("cancels a stalled stream promptly and releases the reader", async () => {
    const cancelled = vi.fn();
    fetchMock.mockImplementation(async () => new Response(new ReadableStream({
      start() { setTimeout(() => controller.abort(), 20); }, cancel: cancelled,
    })));
    await expect(download()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });
  it("checks cancellation after final progress and before rename", async () => {
    state.digest = DEFAULT_VOICE_MODEL.sha256;
    const progress = vi.fn(bytes => { if (bytes === DEFAULT_VOICE_MODEL.size) controller.abort(); });
    await expect(download(progress)).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });
  it("uses a total ten-minute timeout for fetch and cleans staging", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) =>
      realTimeout(callback, delay === 600000 ? 20 : delay)) as typeof setTimeout);
    fetchMock.mockImplementation(async () => new Response(new ReadableStream()));
    await expect(download()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 600000);
    expect(await entries()).toEqual([]);
  });
  it.each(["EACCES", "ENOSPC"])("reports %s without leftover files", async code => {
    vi.mocked(fs.mkdir).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    await expect(download()).rejects.toThrow(code === "EACCES" ? /permission denied/ : /disk space/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });
  it("handles disk exhaustion on sync, zero-length writes, and throwing callbacks", async () => {
    state.digest = DEFAULT_VOICE_MODEL.sha256; state.syncError = true;
    await expect(download()).rejects.toThrow(/disk space/);
    state.syncError = false; state.zeroWrite = true;
    fetchMock.mockResolvedValueOnce(response());
    await expect(download()).rejects.toThrow(/no progress/);
    state.zeroWrite = false; fetchMock.mockResolvedValueOnce(response());
    await expect(download(() => { throw new Error("callback failure"); })).rejects.toThrow(/callback failure/);
    expect(await entries()).toEqual([]);
  });
  it("leaves no partial destination for concurrent downloads and reuses a published model", async () => {
    state.digest = DEFAULT_VOICE_MODEL.sha256;
    fetchMock.mockImplementation(async () => response());
    const progress = vi.fn(() => {
      const voice = join(state.root, "voice");
      for (const name of readdirSync(voice)) {
        if (name.startsWith(".voice-model-")) expect(statSync(join(voice, name)).mode & 0o777).toBe(0o700);
      }
      const destination = join(voice, DEFAULT_VOICE_MODEL.filename);
      if (existsSync(destination)) expect(statSync(destination).size).toBe(DEFAULT_VOICE_MODEL.size);
    });
    const results = await Promise.all([download(progress), download(progress)]);
    expect(results[0]).toBe(results[1]);
    expect(await entries()).toEqual([DEFAULT_VOICE_MODEL.filename]);
    await expect(hasVoiceModel()).resolves.toBe(true);
    const calls = fetchMock.mock.calls.length;
    progress.mockClear();
    await download(progress);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(progress).not.toHaveBeenCalled();
  });
});
