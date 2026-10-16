/**
 * Byte-bounded log readers: tails and cursors read only the ranges they need.
 * UTF-8 handling is reimplemented here to keep background-jobs/* independent of tools/*.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";

export type LogStream = "stdout" | "stderr";

const STREAMS: LogStream[] = ["stdout", "stderr"];

export interface SegmentInfo {
  index: number;
  path: string;
  size: number;
}

function parseSegmentFileName(name: string, stream: LogStream): number | undefined {
  const match = /^([a-z]+)\.(\d+)\.log$/.exec(name);
  if (!match) return undefined;
  if (match[1] !== stream) return undefined;
  const index = Number(match[2]);
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

/** Metadata only (readdir + stat), so polling stays cheap for huge logs. */
export async function listSegments(dir: string, stream: LogStream): Promise<SegmentInfo[]> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results: SegmentInfo[] = [];
  for (const name of entries) {
    const index = parseSegmentFileName(name, stream);
    if (index === undefined) continue;
    const path = join(dir, name);
    const stat = await fsp.stat(path);
    results.push({ index, path, size: stat.size });
  }
  results.sort((a, b) => a.index - b.index);
  return results;
}

/** Skips leading continuation bytes so the slice never starts mid-codepoint. */
function utf8SafeStart(buffer: Buffer, start: number): number {
  let s = Math.max(0, Math.min(start, buffer.length));
  while (s < buffer.length && (buffer[s]! & 0xc0) === 0x80) s++;
  return s;
}

/** Job output is untrusted: control codes other than `\n`/`\t` become visible `\xNN` so they can't drive the terminal. */
export function sanitizeForDisplay(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x09) {
      out += text[i];
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    out += text[i];
  }
  return out;
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  // end is exclusive
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fsp.open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let readTotal = 0;
    while (readTotal < length) {
      const { bytesRead } = await handle.read(buffer, readTotal, length - readTotal, start + readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    return buffer.subarray(0, readTotal);
  } finally {
    await handle.close();
  }
}

/** Reads only the last `maxBytes`, walking segments newest-first. */
export async function readTail(
  dir: string,
  stream: LogStream,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const segments = await listSegments(dir, stream);
  if (segments.length === 0) return { text: "", truncated: false };

  const totalBytes = segments.reduce((sum, s) => sum + s.size, 0);
  let remaining = Math.max(0, maxBytes);
  const parts: Buffer[] = [];
  let bytesCollected = 0;

  for (let i = segments.length - 1; i >= 0 && remaining > 0; i--) {
    const segment = segments[i]!;
    if (segment.size === 0) continue;
    const take = Math.min(segment.size, remaining);
    const start = segment.size - take;
    const buf = await readRange(segment.path, start, segment.size);
    parts.unshift(buf);
    bytesCollected += buf.length;
    remaining -= buf.length;
  }

  const combined = Buffer.concat(parts);
  const truncated = bytesCollected < totalBytes;
  const safeStart = utf8SafeStart(combined, 0);
  const text = sanitizeForDisplay(combined.subarray(safeStart).toString("utf8"));
  return { text, truncated };
}

interface Cursor {
  index: number;
  offset: number;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

function decodeCursor(encoded: string | undefined): Cursor {
  if (!encoded) return { index: 0, offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      Number.isSafeInteger(parsed.index) &&
      Number.isSafeInteger(parsed.offset) &&
      parsed.index >= 0 &&
      parsed.offset >= 0
    ) {
      return { index: parsed.index, offset: parsed.offset };
    }
  } catch {
    // Fall through to the start.
  }
  return { index: 0, offset: 0 };
}

const DEFAULT_CURSOR_MAX_BYTES = 64 * 1024;

function hasLaterSegment(segments: SegmentInfo[], index: number): boolean {
  return segments.some((s) => s.index > index);
}

/** Resumes from `cursor` (or the start) and returns the next cursor. */
export async function readCursor(
  dir: string,
  stream: LogStream,
  cursor?: string,
  maxBytes: number = DEFAULT_CURSOR_MAX_BYTES,
): Promise<{ text: string; truncated: boolean; cursor: string }> {
  const segments = await listSegments(dir, stream);
  let { index, offset } = decodeCursor(cursor);

  if (segments.length === 0) {
    return { text: "", truncated: false, cursor: encodeCursor({ index, offset }) };
  }

  // Stale cursor (older segments evicted): clamp to the earliest retained segment.
  const minIndex = segments[0]!.index;
  if (index < minIndex) {
    index = minIndex;
    offset = 0;
  }

  let remaining = Math.max(0, maxBytes);
  const parts: Buffer[] = [];
  let truncated = false;

  for (const segment of segments) {
    if (segment.index < index) continue;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const startOffset = segment.index === index ? Math.min(offset, segment.size) : 0;
    const available = segment.size - startOffset;
    if (available <= 0) {
      // Only advance once a later segment exists; otherwise the writer may still append here.
      if (hasLaterSegment(segments, segment.index)) {
        index = segment.index + 1;
        offset = 0;
      } else {
        index = segment.index;
        offset = segment.size;
      }
      continue;
    }
    const take = Math.min(available, remaining);
    const buf = await readRange(segment.path, startOffset, startOffset + take);
    parts.push(buf);
    remaining -= buf.length;
    const newOffset = startOffset + buf.length;
    if (newOffset >= segment.size && hasLaterSegment(segments, segment.index)) {
      index = segment.index + 1;
      offset = 0;
    } else {
      index = segment.index;
      offset = newOffset;
    }
    if (buf.length < available) {
      truncated = true;
      break;
    }
  }

  const combined = Buffer.concat(parts);
  const safeStart = utf8SafeStart(combined, 0);
  const text = sanitizeForDisplay(combined.subarray(safeStart).toString("utf8"));
  return { text, truncated, cursor: encodeCursor({ index, offset }) };
}

export interface CompletionExcerptOptions {
  maxExcerptBytes: number;
  outcome: "completed" | "failed" | "interrupted";
}

export interface CompletionExcerpt {
  stdoutExcerpt: string;
  stderrExcerpt: string;
  truncated: boolean;
}

/** A failed job gives stderr the larger share (70/30) since the reason usually lives there; otherwise split evenly. */
export async function buildCompletionExcerpt(
  dir: string,
  opts: CompletionExcerptOptions,
): Promise<CompletionExcerpt> {
  const total = Math.max(0, opts.maxExcerptBytes);
  const [stdoutBudget, stderrBudget] =
    opts.outcome === "failed"
      ? [Math.floor(total * 0.3), total - Math.floor(total * 0.3)]
      : [Math.floor(total / 2), total - Math.floor(total / 2)];

  const [stdoutResult, stderrResult] = await Promise.all([
    readTail(dir, "stdout", stdoutBudget),
    readTail(dir, "stderr", stderrBudget),
  ]);

  return {
    stdoutExcerpt: stdoutResult.text,
    stderrExcerpt: stderrResult.text,
    truncated: stdoutResult.truncated || stderrResult.truncated,
  };
}

export { STREAMS as LOG_STREAMS };
