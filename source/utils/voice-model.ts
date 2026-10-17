import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expandHome, getAgavDir } from "../config/config.js";

export const DEFAULT_VOICE_MODEL = Object.freeze({
  name: "Whisper base.en Q5 (English only)",
  filename: "ggml-base.en-q5_1.bin",
  size: 59721011,
  sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en-q5_1.bin",
} as const);

function managedPath(): string {
  return join(getAgavDir(), "voice", DEFAULT_VOICE_MODEL.filename);
}

export function getVoiceModelPath(): string {
  return process.env.AGAV_VOICE_MODEL ? expandHome(process.env.AGAV_VOICE_MODEL) : managedPath();
}

async function validModel(path: string, explicit: boolean): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && (explicit
      ? info.size >= 1024 ** 2 && info.size <= 4 * 1024 ** 3
      : info.size === DEFAULT_VOICE_MODEL.size);
  } catch {
    return false;
  }
}

/** Local overrides are size-bounded; managed downloads are hashed before publication. */
export async function hasVoiceModel(): Promise<boolean> {
  return validModel(getVoiceModelPath(), Boolean(process.env.AGAV_VOICE_MODEL));
}

/** Downloads only the pinned catalog model, never an override path or URL. */
export async function downloadVoiceModel(
  signal: AbortSignal, onProgress: (bytes: number) => void,
): Promise<string> {
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new DOMException("Voice model download timed out after 10 minutes.", "TimeoutError")), 10 * 60 * 1000);
  timer.unref();
  const destination = managedPath();
  let directory: string | undefined;
  let file: FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const cancelReader = () => { void reader?.cancel(combined.reason).catch(() => {}); };
  try {
    combined.throwIfAborted();
    if (await validModel(destination, false)) {
      combined.throwIfAborted();
      return destination;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    combined.throwIfAborted();
    directory = await mkdtemp(join(dirname(destination), ".voice-model-"));
    const temporaryPath = join(directory, DEFAULT_VOICE_MODEL.filename);
    file = await open(temporaryPath, "wx", 0o600);
    combined.throwIfAborted();
    response = await fetch(DEFAULT_VOICE_MODEL.url, { signal: combined });
    combined.throwIfAborted();
    if (!response.ok) throw new Error(`Voice model download failed: HTTP ${response.status}.`);
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== DEFAULT_VOICE_MODEL.size)) {
      throw new Error(`Voice model size mismatch: expected ${DEFAULT_VOICE_MODEL.size} bytes, Content-Length was ${length}.`);
    }
    if (!response.body) throw new Error("Voice model download returned no body.");
    reader = response.body.getReader();
    combined.addEventListener("abort", cancelReader, { once: true });
    combined.throwIfAborted();
    const hash = createHash("sha256");
    let bytes = 0;
    let lastProgress = -Infinity;
    while (true) {
      const { done, value } = await reader.read();
      combined.throwIfAborted();
      if (done) break;
      if (value.byteLength > DEFAULT_VOICE_MODEL.size - bytes) {
        throw new Error(`Voice model size exceeds the expected ${DEFAULT_VOICE_MODEL.size} bytes.`);
      }
      let offset = 0;
      while (offset < value.byteLength) {
        combined.throwIfAborted();
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
        if (bytesWritten <= 0) throw new Error("Cannot write voice model: disk write made no progress.");
        offset += bytesWritten;
      }
      hash.update(value);
      bytes += value.byteLength;
      const now = Date.now();
      if (now - lastProgress >= 100) {
        onProgress(bytes);
        lastProgress = now;
      }
    }
    if (bytes !== DEFAULT_VOICE_MODEL.size) {
      throw new Error(`Voice model size mismatch: expected ${DEFAULT_VOICE_MODEL.size} bytes, received ${bytes}.`);
    }
    if (hash.digest("hex") !== DEFAULT_VOICE_MODEL.sha256) {
      throw new Error("Voice model SHA-256 checksum mismatch; download was not installed.");
    }
    onProgress(bytes);
    combined.throwIfAborted();
    await file.sync();
    await file.close();
    file = undefined;
    combined.throwIfAborted();
    // A concurrent download may have already published the same catalog model.
    const alreadyInstalled = await validModel(destination, false);
    combined.throwIfAborted();
    if (!alreadyInstalled) await rename(temporaryPath, destination);
    return destination;
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Cannot save voice model to ${destination}: permission denied.`, { cause: error });
    }
    if (code === "ENOSPC" || code === "EDQUOT") {
      throw new Error(`Cannot save voice model to ${destination}: insufficient disk space.`, { cause: error });
    }
    throw new Error(`Voice model download failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", cancelReader);
    // Cancel even on header/HTTP failures so the connection is not left draining.
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else { void response?.body?.cancel().catch(() => {}); }
    try {
      if (file) await file.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
