/**
 * T10 — Bounded segmented log readers.
 *
 * Per solution.md §9: "Read byte-bounded tails/cursors across segments; a
 * line count is only a display preference. List/poll metadata never read
 * entire logs. Completion summaries contain small, labelled excerpts from
 * both stdout and stderr, prioritize according to outcome, preserve real
 * exit codes and indicate truncation. Escape terminal controls and treat
 * output as untrusted data."
 *
 * `listSegments` is metadata-only: it calls `fs.readdir` + `fs.stat` and
 * never opens/reads file contents, so polling job status is cheap even for
 * huge logs.
 *
 * `readTail`/`readCursor` read only the byte ranges they need via
 * `fs.read(fd, buffer, 0, length, position)` with an explicit position —
 * they never read a whole segment just to discard most of it.
 *
 * UTF-8 boundary safety: this module intentionally reimplements the
 * trailing-incomplete-codepoint-safe decoding technique used by
 * `source/tools/shell.ts`'s `utf8Tail` (skip leading continuation bytes
 * 0b10xxxxxx after truncating from the end) rather than importing that
 * tool-layer module, to keep `background-jobs/*` independent of
 * `tools/*` per the module boundaries documented in types.ts/README.md.
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

/**
 * Metadata-only segment listing: readdir + stat, never reads file bodies.
 */
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

/**
 * Finds the leading byte offset of a UTF-8 buffer such that the slice
 * `buffer.subarray(start)` never begins mid-codepoint. Mirrors the
 * boundary-safety technique in tools/shell.ts's `utf8Tail` (skip leading
 * continuation bytes, 0b10xxxxxx, after truncating from the end).
 */
function utf8SafeStart(buffer: Buffer, start: number): number {
  let s = Math.max(0, Math.min(start, buffer.length));
  while (s < buffer.length && (buffer[s]! & 0xc0) === 0x80) s++;
  return s;
}

/**
 * Escapes ANSI/terminal control sequences so raw untrusted job output can
 * never manipulate the viewer's terminal. All C0 control codes except
 * `\n` and `\t` are replaced with a visible `\xNN` placeholder (ESC itself
 * renders as `\x1b`).
 */
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

/**
 * Reads only the last `maxBytes` of the stream's combined segments, walking
 * from the newest segment backward and reading only what's needed (never a
 * whole old segment just to discard most of it).
 */
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
  /** Segment index to resume reading from. */
  index: number;
  /** Byte offset within that segment to resume reading from. */
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

/**
 * Cursor-based incremental read: resumes from the position encoded in
 * `cursor` (or the start, if absent) and reads forward up to `maxBytes`,
 * returning a new cursor for the next call. Repeated polling with the
 * returned cursor never re-reads already-delivered bytes and never skips
 * bytes produced between calls.
 */
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

  // Clamp a stale cursor pointing before the earliest retained segment
  // (e.g. older segments were evicted) forward to the earliest available.
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
      // There is more data available than we read this call.
      truncated = true;
      break;
    }
    const startOffset = segment.index === index ? Math.min(offset, segment.size) : 0;
    const available = segment.size - startOffset;
    if (available <= 0) {
      // Fully consumed this segment already; advance cursor to the next one.
      index = segment.index + 1;
      offset = 0;
      continue;
    }
    const take = Math.min(available, remaining);
    const buf = await readRange(segment.path, startOffset, startOffset + take);
    parts.push(buf);
    remaining -= buf.length;
    const newOffset = startOffset + buf.length;
    if (newOffset >= segment.size) {
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
  // Any bytes trimmed off the end for UTF-8 safety must not be marked as
  // consumed — back the cursor up by the un-decoded trailing bytes so the
  // next call picks them up.
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

/**
 * Small, labelled excerpts from both streams for a completion summary.
 * Per solution.md §9/§10: prioritize the byte budget according to outcome —
 * a failed job gives stderr the larger share (70/30) since the failure
 * reason usually lives there; a clean completion splits evenly.
 */
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
