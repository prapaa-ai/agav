import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("scripts/embed-voice-helper.mjs");
let root: string;
let input: string;
let output: string;
function fixture(target: string, size = 128) {
  const bytes = Buffer.alloc(size);
  if (target.startsWith("darwin")) {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12);
  } else if (target.startsWith("linux")) {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(target.endsWith("arm64") ? 183 : 62, 18);
  } else {
    bytes.write("MZ");
    bytes.writeUInt32LE(64, 60);
    bytes.writeUInt32LE(0x4550, 64);
    bytes.writeUInt16LE(0x8664, 68);
    bytes.writeUInt16LE(0x20b, 88);
  }
  return bytes;
}
function generate(target = "darwin-arm64", path = input, destination = output) {
  return spawnSync(process.execPath, [script, target, path, destination], { encoding: "utf8" });
}
async function bundle() {
  const text = await readFile(output, "utf8");
  const match = text.match(/export const BUNDLED_VOICE_RUNTIME: BundledVoiceRuntime \| null = (\{[\s\S]*\});\n$/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as { target: string; size: number; sha256: string; gzipBase64: string; licenses: { whisper: string; miniaudio: string } };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-embed-test-"));
  input = join(root, "helper");
  output = join(root, "nested", "bundled-runtime.ts");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("embed-voice-helper generator", () => {
  it("embeds an optional x64 sibling and rejects invalid siblings atomically", async () => {
    await writeFile(input, fixture("linux-x64"));
    const optimized = fixture("linux-x64", 256);
    await writeFile(`${input}.avx2`, optimized);
    expect(generate("linux-x64").status).toBe(0);
    const data = await bundle() as Awaited<ReturnType<typeof bundle>> & { avx2: { gzipBase64: string; sha256: string } };
    expect(gunzipSync(Buffer.from(data.avx2.gzipBase64, "base64"))).toEqual(optimized);
    expect(data.avx2.sha256).toBe(createHash("sha256").update(optimized).digest("hex"));
    const previous = await readFile(output, "utf8");
    await writeFile(`${input}.avx2`, fixture("linux-arm64"));
    expect(generate("linux-x64").status).toBe(1);
    expect(await readFile(output, "utf8")).toBe(previous);
  });
  it.each(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"])("embeds real bytes and licenses for %s without executing", async target => {
    const bytes = fixture(target);
    await writeFile(input, bytes);
    const result = generate(target);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`${bytes.length} bytes`);
    const data = await bundle();
    expect(data.target).toBe(target);
    expect(data.size).toBe(bytes.length);
    expect(data.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(gunzipSync(Buffer.from(data.gzipBase64, "base64"))).toEqual(bytes);
    expect(data.licenses.whisper).toBe(await readFile("native/voice/LICENSE.whisper.cpp", "utf8"));
    expect(data.licenses.miniaudio).toBe(await readFile("native/voice/LICENSE.miniaudio", "utf8"));
    expect(await readdir(join(root, "nested"))).toEqual(["bundled-runtime.ts"]);
    const first = await readFile(output, "utf8");
    expect(generate(target).status).toBe(0);
    expect(await readFile(output, "utf8")).toBe(first);
  });
  it("accepts helpers larger than 2 MiB and records their actual size", async () => {
    const bytes = fixture("darwin-arm64", 2 * 1024 * 1024 + 1);
    await writeFile(input, bytes);
    const result = generate();
    expect(result.status, result.stderr).toBe(0);
    const data = await bundle();
    expect(data.size).toBe(bytes.length);
    expect(data.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const restored = gunzipSync(Buffer.from(data.gzipBase64, "base64"));
    expect(restored.length).toBe(bytes.length);
    expect(restored.equals(bytes)).toBe(true);
  });
  it.each(["darwin-riscv64", "win32-arm64", "toString", "../linux-x64"])("rejects unknown target %s", async target => {
    await writeFile(input, fixture("darwin-arm64"));
    const result = generate(target);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown targets");
  });
  it.each(["empty", "text", "wrong-family", "wrong-arch", "truncated", "oversized", "symlink", "missing"])("rejects %s and preserves an existing generated output", async kind => {
    await writeFile(input, fixture("darwin-arm64"));
    expect(generate().status).toBe(0);
    const previous = await readFile(output, "utf8");
    if (kind === "empty") await writeFile(input, "");
    if (kind === "text") await writeFile(input, "#!/bin/sh\necho wrong");
    if (kind === "wrong-family") await writeFile(input, fixture("linux-arm64"));
    if (kind === "wrong-arch") await writeFile(input, fixture("darwin-x64"));
    if (kind === "truncated") await writeFile(input, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    if (kind === "oversized") await truncate(input, 128 * 1024 * 1024 + 1);
    if (kind === "symlink") { await rm(input); await symlink(output, input); }
    if (kind === "missing") await rm(input);
    const result = generate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot embed voice helper");
    expect(await readFile(output, "utf8")).toBe(previous);
    expect(await readdir(join(root, "nested"))).toEqual(["bundled-runtime.ts"]);
  });
  it("validates PE signature, not merely MZ", async () => {
    const bytes = fixture("win32-x64");
    bytes.writeUInt32LE(0, 64);
    await writeFile(input, bytes);
    expect(generate("win32-x64").stderr).toContain("Invalid executable magic");
  });
  it("rejects invalid CLI arity", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});
