import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_SAVED_OUTPUT_BYTES = 16 * 1024 * 1024;
export const PROCESS_OUTPUT_BYTES = 128 * 1024 * 1024;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
// Fixed-slot admission reserves an entire process budget. Across processes
// sharing this uid/temp root: 32 * 128 MiB of payload (plus bounded metadata).
const ROOT_SLOTS = 32;

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)) {
    throw new Error("Unsafe temporary output directory");
  }
}

function dead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Reservations include unfinished writes, not just published logs. */
export class TempOutputManager {
  private session?: string;
  private used = 0;
  private files = 0;
  private closed = false;
  private pending = new Set<TemporaryOutput>();

  constructor(
    private root = join(tmpdir(), `agav-output-v1-${process.getuid?.() ?? "user"}`),
    private budget = PROCESS_OUTPUT_BYTES,
    private slots = ROOT_SLOTS,
    private ttl = STALE_TTL_MS,
  ) {}

  private initialize(): string {
    if (this.closed) throw new Error("Temporary output manager shut down");
    if (this.session) return this.session;
    try { mkdirSync(this.root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    privateDirectory(this.root);
    this.prune();
    for (let i = 0; i < this.slots; i++) {
      const directory = join(this.root, `slot-${i}`);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try {
        writeFileSync(join(directory, "owner.json"), JSON.stringify({ version: 1, pid: process.pid, created: Date.now(), slot: i }), { flag: "wx", mode: 0o600 });
        this.session = directory;
        return directory;
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    }
    throw new Error("Temporary output root reservation quota reached");
  }

  /** Startup sweep only touches this manager's validated private root. */
  pruneStale(): void {
    try { privateDirectory(this.root); this.prune(); } catch { /* Optional startup maintenance. */ }
  }

  private prune(): void {
    for (let i = 0; i < this.slots; i++) {
      const directory = join(this.root, `slot-${i}`);
      try {
        privateDirectory(directory);
        // Claim before reading ownership. Another pruner cannot use stale
        // metadata to delete a newly admitted process in a reused slot.
        const lock = join(directory, "prune.lock");
        try { mkdirSync(lock, { mode: 0o700 }); } catch { continue; }
        const lockIdentity = lstatSync(lock);
        try {
          const identity = lstatSync(directory);
          const ownerPath = join(directory, "owner.json");
          const stat = lstatSync(ownerPath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) continue;
          const fd = openSync(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          let owner;
          try { owner = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
          // Live PIDs (including PID reuse), denied probes and unknown metadata
          // are protected conservatively. Idle live sessions never expire.
          if (owner.version !== 1 || owner.slot !== i || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
              !Number.isSafeInteger(owner.created) || owner.created <= 0 || Date.now() - owner.created < this.ttl || !dead(owner.pid)) continue;
          if (lstatSync(directory).ino !== identity.ino || !dead(owner.pid)) continue;
          rmSync(directory, { recursive: true, force: true });
        } finally {
          // If deletion succeeded, do not touch a replacement slot's lock.
          // Otherwise remove only our lock; admission never replaces a slot.
          try { if (lstatSync(lock).ino === lockIdentity.ino) rmdirSync(lock); } catch {}
        }
      } catch { /* Unknown/unowned entries are never removed. */ }
    }
  }

  create(limit = MAX_SAVED_OUTPUT_BYTES): TemporaryOutput {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SAVED_OUTPUT_BYTES) throw new Error("Invalid output reservation");
    if (this.closed || this.files >= 4096 || this.used + limit > this.budget) throw new Error("Temporary output process retention quota reached");
    const session = this.initialize();
    this.used += limit;
    this.files++;
    let directory: string | undefined;
    try {
      directory = mkdtempSync(join(session, "output-"));
      const output = new TemporaryOutput(directory, limit, this);
      this.pending.add(output);
      return output;
    } catch (error) {
      this.used -= limit;
      this.files--;
      if (directory) rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  release(output: TemporaryOutput, reservation: number, retained: number): void {
    if (!this.pending.delete(output)) return;
    this.used -= reservation - retained;
  }

  cleanup(): void {
    this.closed = true;
    for (const output of [...this.pending]) output.discard();
    if (this.session) {
      try { rmSync(this.session, { recursive: true, force: true }); } catch { /* Best effort at exit. */ }
      this.session = undefined;
    }
    this.used = 0;
  }
}

export class TemporaryOutput {
  private fd?: number;
  private written = 0;
  private finished = false;
  partial = false;

  constructor(private directory: string, private limit: number, private manager: TempOutputManager) {
    this.fd = openSync(join(directory, "output.tmp"), "wx", 0o600);
  }

  write(chunk: Buffer): void {
    if (this.finished) throw new Error("Output capture already finished");
    if (this.partial) return;
    const remaining = this.limit - this.written;
    if (chunk.length > remaining) {
      this.partial = true;
      chunk = Buffer.from(new TextDecoder("utf-8", { ignoreBOM: true }).decode(chunk.subarray(0, remaining), { stream: true }));
    }
    let offset = 0;
    while (offset < chunk.length) {
      const count = writeSync(this.fd!, chunk, offset, chunk.length - offset);
      if (count <= 0) throw new Error("Unable to save output");
      offset += count;
      this.written += count;
    }
  }

  publish(): string {
    if (this.finished) throw new Error("Output capture already finished");
    closeSync(this.fd!);
    this.fd = undefined;
    const path = join(this.directory, "output.log");
    renameSync(join(this.directory, "output.tmp"), path);
    this.finished = true;
    this.manager.release(this, this.limit, this.written);
    return path;
  }

  discard(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.fd !== undefined) { try { closeSync(this.fd); } catch {} this.fd = undefined; }
    try { rmSync(this.directory, { recursive: true, force: true }); } catch {}
    // Keep the reservation if deletion failed: disk bytes still count.
    let retained = 0;
    try { lstatSync(this.directory); retained = this.limit; } catch {}
    this.manager.release(this, this.limit, retained);
  }
}

export const tempOutputManager = new TempOutputManager();
// Exit only: CLI/Ink retain existing signals and cancelled-turn behavior.
process.once("exit", () => tempOutputManager.cleanup());
