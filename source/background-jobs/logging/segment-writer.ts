/**
 * Supervisor-owned writer with independent numbered segments per stream (`stdout.0.log`, ...).
 * Rotation closes the current segment and opens the next; it never renames a file the workload
 * still writes. The retained-bytes quota spans both streams combined. Chunks are opaque bytes
 * (UTF-8 is the reader's concern). Failures go to `onFailure` and never throw out of the write
 * path; this module never acts on a process.
 */
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type LogStream = "stdout" | "stderr";

const STREAMS: LogStream[] = ["stdout", "stderr"];

const DELETE_RETRY_ATTEMPTS = 3;
const DELETE_RETRY_DELAY_MS = 50;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SegmentedLogWriterOptions {
  segmentBytes: number;
  /** Combined across both streams. */
  retainedBytesPerJob: number;
  onFailure: (reason: string) => void;
}

interface StreamState {
  currentIndex: number;
  handle?: FileHandle;
  currentSize: number;
}

function segmentPath(dir: string, stream: LogStream, index: number): string {
  return join(dir, `${stream}.${index}.log`);
}

function parseSegmentFileName(name: string, stream: LogStream): number | undefined {
  const match = /^([a-z]+)\.(\d+)\.log$/.exec(name);
  if (!match) return undefined;
  if (match[1] !== stream) return undefined;
  const index = Number(match[2]);
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

export class SegmentedLogWriter {
  private readonly dir: string;
  private readonly segmentBytes: number;
  private readonly retainedBytesPerJob: number;
  private readonly onFailure: (reason: string) => void;
  private readonly state: Record<LogStream, StreamState> = {
    stdout: { currentIndex: 0, currentSize: 0 },
    stderr: { currentIndex: 0, currentSize: 0 },
  };
  private initialized = false;
  private closed = false;

  constructor(dir: string, opts: SegmentedLogWriterOptions) {
    this.dir = dir;
    this.segmentBytes = Math.max(1, opts.segmentBytes);
    this.retainedBytesPerJob = Math.max(1, opts.retainedBytesPerJob);
    this.onFailure = opts.onFailure;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });

    for (const stream of STREAMS) {
      let highest = -1;
      let entries: string[] = [];
      try {
        entries = await fs.readdir(this.dir);
      } catch {
        entries = [];
      }
      for (const name of entries) {
        const index = parseSegmentFileName(name, stream);
        if (index !== undefined && index > highest) highest = index;
      }
      const resumeIndex = highest >= 0 ? highest : 0;
      let size = 0;
      try {
        const stat = await fs.stat(segmentPath(this.dir, stream, resumeIndex));
        size = stat.size;
      } catch {
        size = 0;
      }
      this.state[stream].currentIndex = resumeIndex;
      this.state[stream].currentSize = size;
    }

    this.initialized = true;
  }

  private async ensureHandle(stream: LogStream): Promise<FileHandle> {
    const s = this.state[stream];
    if (s.handle) return s.handle;
    const path = segmentPath(this.dir, stream, s.currentIndex);
    const handle = await fs.open(path, "a");
    s.handle = handle;
    return handle;
  }

  private async rotate(stream: LogStream): Promise<void> {
    const s = this.state[stream];
    if (s.handle) {
      await s.handle.close().catch(() => {});
      s.handle = undefined;
    }
    s.currentIndex += 1;
    s.currentSize = 0;
  }

  async write(stream: LogStream, chunk: Buffer): Promise<void> {
    if (this.closed) return;
    if (!this.initialized) await this.init();
    if (chunk.length === 0) return;

    let offset = 0;
    while (offset < chunk.length) {
      const s = this.state[stream];
      const remainingInSegment = this.segmentBytes - s.currentSize;
      if (remainingInSegment <= 0) {
        await this.rotate(stream);
        continue;
      }
      const sliceLen = Math.min(remainingInSegment, chunk.length - offset);
      const slice = chunk.subarray(offset, offset + sliceLen);
      try {
        const handle = await this.ensureHandle(stream);
        await handle.appendFile(slice);
      } catch (error) {
        this.onFailure(`segment write failed: ${String((error as Error)?.message ?? error)}`);
        // The slice is dropped, but offset still advances so we don't spin.
      }
      s.currentSize += sliceLen;
      offset += sliceLen;

      if (s.currentSize >= this.segmentBytes) {
        await this.rotate(stream);
      }

      await this.enforceRetention();
    }
  }

  private async listAllSegmentsWithStats(): Promise<
    Array<{ stream: LogStream; index: number; path: string; size: number; mtimeMs: number }>
  > {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const results: Array<{ stream: LogStream; index: number; path: string; size: number; mtimeMs: number }> = [];
    for (const name of entries) {
      for (const stream of STREAMS) {
        const index = parseSegmentFileName(name, stream);
        if (index === undefined) continue;
        const path = join(this.dir, name);
        try {
          const stat = await fs.stat(path);
          results.push({ stream, index, path, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // Vanished between readdir and stat; ignore.
        }
        break;
      }
    }
    return results;
  }

  private async deleteWithRetry(path: string): Promise<boolean> {
    let lastError: unknown;
    // Bounded retries tolerate transient Windows sharing violations.
    for (let attempt = 0; attempt < DELETE_RETRY_ATTEMPTS; attempt++) {
      try {
        await fs.unlink(path);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return true;
        lastError = error;
        if (attempt < DELETE_RETRY_ATTEMPTS - 1) await sleep(DELETE_RETRY_DELAY_MS);
      }
    }
    this.onFailure(`segment deletion failed: ${path}: ${String((lastError as Error)?.message ?? lastError)}`);
    return false;
  }

  /** Deletes oldest segments (lowest index, then mtime) across both streams until under budget. */
  private async enforceRetention(): Promise<void> {
    const all = await this.listAllSegmentsWithStats();
    let total = all.reduce((sum, s) => sum + s.size, 0);
    if (total <= this.retainedBytesPerJob) return;

    const candidates = all
      // Never delete the segment a stream is actively writing into.
      .filter((s) => this.state[s.stream].currentIndex !== s.index)
      .sort((a, b) => (a.index - b.index) || (a.mtimeMs - b.mtimeMs));

    for (const candidate of candidates) {
      if (total <= this.retainedBytesPerJob) break;
      const deleted = await this.deleteWithRetry(candidate.path);
      if (deleted) total -= candidate.size;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stream of STREAMS) {
      const s = this.state[stream];
      if (s.handle) {
        await s.handle.close().catch(() => {});
        s.handle = undefined;
      }
    }
  }
}
