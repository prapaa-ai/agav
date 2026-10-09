/**
 * T10 — Supervisor-owned, segmented, multi-stream log writer.
 *
 * Per solution.md §9: "The supervisor consumes workload pipes and owns all
 * retained log files. Rotate into numbered segments by closing the current
 * segment and opening the next—not by renaming a file the workload still
 * writes. Readers must release handles; Windows deletion failures receive
 * bounded retries." and "Never grow beyond quota or block the workload
 * indefinitely because logging stalled."
 *
 * Ownership boundary (per README.md / types.ts module map): this module
 * reports failures via `opts.onFailure` only. It never signals, stops or
 * otherwise acts on a process — that is the supervisor's (T11) job, acting
 * on the decision produced by `logging/failure-policy.ts`.
 *
 * Design notes:
 *  - Each stream ("stdout"/"stderr") has its own independently numbered
 *    segment sequence: `stdout.0.log`, `stdout.1.log`, ... and
 *    `stderr.0.log`, `stderr.1.log`, ... living side by side in `dir`.
 *  - A single long-lived append `FileHandle` is kept open per stream for
 *    write efficiency (avoids open/close syscalls per chunk). The handle is
 *    closed whenever the segment rotates (so we never keep writing into a
 *    file we've logically "closed") and on `close()`/rotation-failure.
 *  - Byte accounting (`retainedBytesPerJob`) is tracked across BOTH streams
 *    combined, matching `ResourceLimits.retainedLogBytesPerJob` which is
 *    documented in types.ts as "both streams combined". When the combined
 *    total exceeds the budget, the oldest segments (lowest index, oldest by
 *    mtime, considered across either stream) are deleted until back under
 *    budget.
 *  - The writer treats all chunks as opaque bytes. It never attempts UTF-8
 *    decoding/validation — that is strictly the reader's job at display
 *    time (see segment-reader.ts).
 *  - A single enormous chunk larger than `segmentBytes` is split across as
 *    many segment boundaries as necessary; each split still obeys the
 *    close-current/open-next rotation discipline (never rename a file still
 *    being written).
 *  - Segment deletion during eviction is retried up to 3 times, 50ms apart,
 *    to tolerate transient Windows-style sharing-violation-equivalent
 *    failures (this writer runs on Linux in CI, but the retry loop is
 *    written generically so the same code behaves correctly when this
 *    module eventually runs on Windows). If deletion still fails after
 *    retries, `opts.onFailure` is invoked and rotation/writing continues —
 *    a logging failure never throws out of the write path.
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
  /** Maximum size in bytes of a single segment file before rotating. */
  segmentBytes: number;
  /** Maximum combined on-disk bytes retained across both streams for this job. */
  retainedBytesPerJob: number;
  /** Called (never throws) when a logging-layer operation fails irrecoverably. Never acts on a process. */
  onFailure: (reason: string) => void;
}

interface StreamState {
  /** Index of the segment currently open for appending (or about to be opened). */
  currentIndex: number;
  /** Open append handle for `currentIndex`, if any. */
  handle?: FileHandle;
  /** Bytes already written into the currently open segment. */
  currentSize: number;
}

function segmentPath(dir: string, stream: LogStream, index: number): string {
  return join(dir, `${stream}.${index}.log`);
}

/**
 * Matches `stdout.<n>.log` / `stderr.<n>.log` and extracts `<n>`.
 */
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
    // The next write() call will lazily open the new segment via ensureHandle.
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
        // Degrade gracefully: drop this slice rather than throwing out of the
        // write path, but still advance offset so we don't spin forever.
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

  /**
   * Deletes oldest segments (lowest index first, tie-broken by mtime) across
   * either stream until combined retained bytes are back under budget. Never
   * deletes a stream's currently-open segment (that would violate the
   * "close then open next, never touch a file still being written"
   * discipline, and the currently open segment is still accruing).
   */
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
