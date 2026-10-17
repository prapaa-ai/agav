import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expandHome, getAgavDir } from "../config/config.js";
import { VERSION } from "../version.js";
import type { BundledVoiceRuntime } from "../voice/bundled-runtime.js";

const execute = promisify(execFile);
const MAX_HELPER = 128 * 1024 * 1024;
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);

function target(): string {
  const key = `${process.platform}-${process.arch}`;
  if (!TARGETS.has(key)) {
    throw new Error(`Voice runtime is not supported on ${key}. Windows ARM64 requires an x64 Agav process under emulation.`);
  }
  return key;
}

let selectedRuntime: { baseline: string; path: string } | undefined;
function baselinePath(): string {
  return join(getAgavDir(), "voice", "runtime", VERSION, target(), process.platform === "win32" ? "agav-voice.exe" : "agav-voice");
}
export function getVoiceRuntimePath(): string {
  return process.env.AGAV_VOICE_HELPER_BIN !== undefined
    ? expandHome(process.env.AGAV_VOICE_HELPER_BIN)
    : selectedRuntime?.baseline === baselinePath() && process.env.AGAV_VOICE_CPU_BASELINE !== "1" ? selectedRuntime.path : baselinePath();
}

async function explicitRuntime(path: string, signal: AbortSignal): Promise<void> {
  try {
    if (!path || path.includes("\0")) throw new Error("empty or invalid path");
    const info = await stat(path);
    signal.throwIfAborted();
    if (!info.isFile()) throw new Error("not a regular file");
    if (process.platform === "win32" && !/^\.(exe|com)$/i.test(extname(path))) throw new Error("must be a native .exe or .com executable");
    await access(path, process.platform === "win32" ? constants.R_OK : constants.R_OK | constants.X_OK);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`Invalid AGAV_VOICE_HELPER_BIN: ${path || "(empty path)"}. Set it to a readable executable file.`, { cause: error });
  }
}

function metadata(value: BundledVoiceRuntime): BundledVoiceRuntime {
  if (!value || typeof value !== "object" || value.target !== target()) {
    throw new Error(`Bundled voice runtime target mismatch (expected ${target()}). Rebuild for this platform and architecture.`);
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_HELPER ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.gzipBase64 !== "string" || !value.gzipBase64.length ||
      value.gzipBase64.length > Math.ceil((MAX_HELPER + 1024 * 1024) / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.gzipBase64) || value.gzipBase64.length % 4 !== 0 ||
      Buffer.from(value.gzipBase64, "base64").toString("base64") !== value.gzipBase64 ||
      !value.licenses || typeof value.licenses.whisper !== "string" || !value.licenses.whisper.trim() ||
      typeof value.licenses.miniaudio !== "string" || !value.licenses.miniaudio.trim()) {
    throw new Error("Invalid bundled voice runtime size, SHA-256, gzip payload or licenses.");
  }
  // Snapshot the lazy module's metadata before any asynchronous filesystem work.
  return { ...value, licenses: { ...value.licenses } };
}

async function verifiedRuntime(path: string, bundle: BundledVoiceRuntime, signal: AbortSignal): Promise<boolean> {
  try {
    const info = await lstat(path);
    signal.throwIfAborted();
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink in voice runtime cache: ${path}`);
    if (!info.isFile() || info.size !== bundle.size) return false;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      signal.throwIfAborted();
      const opened = await file.stat();
      signal.throwIfAborted();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== bundle.size) return false;
      await access(path, process.platform === "win32" ? constants.R_OK : constants.R_OK | constants.X_OK);
      signal.throwIfAborted();
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        signal.throwIfAborted();
        if (!bytesRead) break;
        size += bytesRead;
        if (size > bundle.size) return false;
        hash.update(buffer.subarray(0, bytesRead));
      }
      return size === bundle.size && hash.digest("hex") === bundle.sha256;
    } finally { await file.close(); }
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    // A cached non-executable file is repaired; other permission failures are actionable.
    if (code === "EACCES") {
      const info = await lstat(path);
      signal.throwIfAborted();
      if (info.isFile() && (info.mode & 0o111) === 0 && (info.mode & 0o444) !== 0) return false;
    }
    throw error;
  }
}

async function writeStaged(path: string, bytes: Uint8Array | string, mode: number, signal: AbortSignal): Promise<void> {
  const file = await open(path, "wx", mode);
  try {
    signal.throwIfAborted();
    await file.writeFile(bytes);
    signal.throwIfAborted();
    await file.chmod(mode);
    signal.throwIfAborted();
    await file.sync();
    signal.throwIfAborted();
  } finally { await file.close(); }
  signal.throwIfAborted();
}

/** Materialize the bundled native helper locally. Protocol negotiation belongs to the adapter. */
export async function ensureVoiceRuntime(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const path = process.env.AGAV_VOICE_HELPER_BIN !== undefined ? getVoiceRuntimePath() : baselinePath();
  selectedRuntime = undefined;
  if (process.env.AGAV_VOICE_HELPER_BIN !== undefined) {
    await explicitRuntime(path, signal);
    signal.throwIfAborted();
    return path;
  }
  const { BUNDLED_VOICE_RUNTIME } = await import("../voice/bundled-runtime.js");
  signal.throwIfAborted();
  if (BUNDLED_VOICE_RUNTIME === null) {
    throw new Error("Voice is not bundled in this development build. Opt in with pnpm build:binary --voice (requires CMake/C++ or AGAV_VOICE_HELPER_PATH), or set AGAV_VOICE_HELPER_BIN to an existing native helper. Normal builds do not require native tools.");
  }
  const bundle = metadata(BUNDLED_VOICE_RUNTIME);
  await materializeRuntime(path, bundle, signal);
  if (process.arch !== "x64" || bundle.avx2 === undefined || process.env.AGAV_VOICE_CPU_BASELINE === "1") return path;
  // Only the baseline executable may probe CPU/OS capability. Never run the
  // optimized helper speculatively, including for protocol negotiation.
  try {
    const result = await execute(path, ["--supports-avx2"], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 1024, windowsHide: true, signal,
    });
    signal.throwIfAborted();
    if (result.stdout.trim() !== "1" || result.stderr.trim()) return path;
  } catch {
    signal.throwIfAborted();
    return path;
  }
  const optimized = metadata(bundle.avx2);
  // Keep .exe as the final extension so Windows can launch the optimized PE.
  const optimizedPath = process.platform === "win32" ? path.replace(/\.exe$/i, ".avx2.exe") : `${path}.avx2`;
  await materializeRuntime(optimizedPath, optimized, signal);
  selectedRuntime = { baseline: path, path: optimizedPath };
  return optimizedPath;
}

async function materializeRuntime(path: string, bundle: BundledVoiceRuntime, signal: AbortSignal): Promise<string> {
  let staging: string | undefined;
  try {
    const valid = await verifiedRuntime(path, bundle, signal);
    signal.throwIfAborted();
    // Always stage licenses as well: a cache hit must not lose its attribution files.
    let bytes: Buffer | undefined;
    if (!valid) {
      try { bytes = gunzipSync(Buffer.from(bundle.gzipBase64, "base64"), { maxOutputLength: MAX_HELPER }); }
      catch (error) { throw new Error("Cannot unpack bundled voice runtime gzip payload (maximum 128 MiB).", { cause: error }); }
      signal.throwIfAborted();
      if (bytes.length !== bundle.size) throw new Error("Bundled voice runtime size mismatch.");
      if (createHash("sha256").update(bytes).digest("hex") !== bundle.sha256) throw new Error("Bundled voice runtime SHA-256 mismatch.");
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    staging = await mkdtemp(join(dirname(path), ".voice-runtime-"));
    signal.throwIfAborted();
    const licenses = [
      ["LICENSE.whisper.cpp.txt", bundle.licenses.whisper],
      ["LICENSE.miniaudio.txt", bundle.licenses.miniaudio],
    ] as const;
    for (const [name, text] of licenses) {
      await writeStaged(join(staging, name), text, 0o600, signal);
      signal.throwIfAborted();
    }
    if (bytes) {
      await writeStaged(join(staging, "helper"), bytes, 0o700, signal);
      signal.throwIfAborted();
    }
    // Unique staging directories make parallel installers safe: all publish identical bytes.
    // Publish attribution first, and the fully fsynced executable last.
    for (const [name] of licenses) {
      await rename(join(staging, name), `${path}.${name}`);
      signal.throwIfAborted();
    }
    if (bytes) {
      await rename(join(staging, "helper"), path);
      signal.throwIfAborted();
    }
    return path;
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOSPC" || code === "EDQUOT") throw new Error("Cannot install voice runtime: insufficient disk space.", { cause: error });
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw new Error(`Cannot install voice runtime: permission denied or read-only cache at ${dirname(path)}.`, { cause: error });
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
