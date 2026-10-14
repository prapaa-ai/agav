/**
 * T05 — Single-writer lock helpers.
 *
 * Wraps `PlatformAdapter.acquireLock` to provide "single lifecycle writer
 * per job" and "single coordinator writer" guarantees described in
 * solution.md §7. On `lock-held` from a DIFFERENT call stack this never
 * retries in a loop and never steals a lock from a live (or unverifiable)
 * owner. Age/timestamps are never used to seize a lock.
 *
 * Verified-gone recovery (plan item 0.1, WP-02): on `lock-held`, the lock
 * file's holder record (`{pid, acquiredAt, processStartTime?, hostname?}`)
 * is read. The lock is recovered only when the owner is verified gone
 * (`isLockOwnerGone`), which means all of the following hold:
 *   - the holder was written on this host (a recorded hostname must equal
 *     `os.hostname()`; legacy records with no hostname are treated as local,
 *     because storage roots are required to be local, see paths.ts), and
 *   - either the pid no longer exists (`kill(pid, 0)` → ESRCH; EPERM means
 *     alive), or the pid exists but belongs to a different process: the
 *     recorded `processStartTime` differs from the live process's start time.
 * A missing, empty, corrupt or unreadable holder record is never recovered,
 * because liveness can't be verified, so the original `lock-held` propagates.
 * When the owner is verified gone, the stale file is renamed into
 * `quarantine/` (never deleted), and the O_EXCL acquisition is retried exactly
 * once. Recoverers are serialized by a short-lived `<lock>.recovery` guard
 * lock. The quarantined file's identity (dev/ino + content) is also re-checked
 * after the rename, so a live lock that was moved by mistake is restored in
 * place.
 *
 * Reentrancy (integration-owner fix): `Repositories.jobs.update()` already
 * acquires this same per-job lock internally (see repositories.ts). Any
 * caller that legitimately needs a single atomic "read current record under
 * lock, decide, then call `jobs.update()`" critical section — e.g. T12's
 * recovery reconciler, or T14's coordinator admission path — would
 * otherwise deadlock against itself, since the underlying OS-held lock
 * (`PlatformAdapter.acquireLock`, an O_EXCL file create) is not reentrant.
 *
 * To avoid every caller inventing its own "write around the repository"
 * workaround (as T12 initially had to), `withJobLock`/`withCoordinatorLock`
 * track currently-held locks per async execution context via
 * `AsyncLocalStorage`: a nested call for the SAME lock name, from code
 * running inside an outer `withJobLock`/`withCoordinatorLock` call for that
 * same name, runs `fn` directly without re-acquiring the OS lock. A nested
 * call for a *different* name still acquires its own OS lock normally.
 * Mutual exclusion across different call stacks / processes is unaffected —
 * only same-stack reentrancy is special-cased.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname as osHostname } from "node:os";
import { basename, join } from "node:path";
import { getPlatformAdapter, lockOwnerPidExists, readLockOwnerStartTime } from "../platform/index.js";
import { BackgroundJobError } from "../types.js";
import type { PlatformAdapter } from "../types.js";
import { lockPath, quarantineDir } from "./paths.js";

interface LockContext {
  /** Lock names currently held by this (possibly nested) call stack. */
  held: Set<string>;
}

const lockContext = new AsyncLocalStorage<LockContext>();

// ---------------------------------------------------------------------------
// Lock holder records + verified-gone check (exported for WP-11's daemon lock, D9)
// ---------------------------------------------------------------------------

/** Parsed contents of a lock file. Legacy files carry only `pid` + `acquiredAt`. */
export interface LockHolder {
  pid: number;
  acquiredAt?: string;
  /** Process start time as recorded by the POSIX lock writer; absent on Windows / legacy files. */
  processStartTime?: string;
  /** `os.hostname()` of the writer; absent on legacy files. */
  hostname?: string;
}

/** Injectable probes for `isLockOwnerGone` (tests only; defaults are the real platform helpers). */
export interface LockOwnerProbes {
  hostname: () => string;
  pidExists: (pid: number) => Promise<boolean>;
  readStartTime: (pid: number) => Promise<string | undefined>;
}

const defaultProbes: LockOwnerProbes = {
  hostname: osHostname,
  pidExists: lockOwnerPidExists,
  readStartTime: readLockOwnerStartTime,
};

interface LockFileSnapshot {
  raw: string;
  dev: bigint;
  ino: bigint;
  holder: LockHolder | undefined;
}

function parseLockHolder(raw: string): LockHolder | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const { pid, acquiredAt, processStartTime, hostname } = record;
  // pid <= 0 must never reach kill(): 0 / negatives address process groups.
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  for (const optional of [acquiredAt, processStartTime, hostname]) {
    if (optional !== undefined && typeof optional !== "string") return undefined;
  }
  const holder: LockHolder = { pid };
  if (acquiredAt !== undefined) holder.acquiredAt = acquiredAt as string;
  if (processStartTime !== undefined) holder.processStartTime = processStartTime as string;
  if (hostname !== undefined) holder.hostname = hostname as string;
  return holder;
}

/**
 * Read a lock file through one handle, so the identity (dev/ino) and the
 * content belong to the same file. Returns `undefined` if the file can't be
 * read at all (missing, or a transient sharing violation).
 */
async function snapshotLockFile(path: string): Promise<LockFileSnapshot | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, "r");
    const stat = await handle.stat({ bigint: true });
    const raw = await handle.readFile("utf8");
    return { raw, dev: stat.dev, ino: stat.ino, holder: parseLockHolder(raw) };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Read and validate the holder record of a lock file. Returns `undefined`
 * when the file is missing, empty, corrupt, unreadable or has an invalid pid.
 * Callers must treat `undefined` as "liveness unverifiable" (never recover).
 */
export async function readLockHolder(path: string): Promise<LockHolder | undefined> {
  return (await snapshotLockFile(path))?.holder;
}

/**
 * True only on positive evidence that the lock's owner process is gone:
 * same host (or a legacy record with no hostname), and either the pid doesn't
 * exist or it has been reused (the recorded start time differs from the live
 * one). If anything can't be verified (another host, start time unreadable,
 * probe errors) the result is `false`. Lock age is never considered.
 */
export async function isLockOwnerGone(holder: LockHolder, probes: Partial<LockOwnerProbes> = {}): Promise<boolean> {
  const p: LockOwnerProbes = { ...defaultProbes, ...probes };
  try {
    if (holder.hostname !== undefined && holder.hostname !== p.hostname()) return false;
    if (!(await p.pidExists(holder.pid))) return true;
    if (holder.processStartTime === undefined) return false; // pid alive, reuse undetectable
    const current = await p.readStartTime(holder.pid);
    if (current === undefined) return false; // can't read: not verifiably a different process
    return current !== holder.processStartTime;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function isLockHeld(error: unknown): boolean {
  return error instanceof BackgroundJobError && error.code === "lock-held";
}

/**
 * Rename `path` into `quarantine` if it is still the exact file described by
 * `expected`. If the moved file turns out to be different (it was replaced
 * between the check and the rename), it is put back without overwriting
 * anything.
 */
async function quarantineIfUnchanged(
  path: string,
  expected: LockFileSnapshot,
  quarantine: string,
): Promise<"moved" | "missing" | "changed"> {
  await fs.mkdir(quarantine, { recursive: true, mode: 0o700 });
  const target = join(quarantine, `${basename(path)}.stale-${Date.now()}-${randomUUID()}`);
  try {
    await fs.rename(path, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  // Defence in depth: under the recovery guard nothing else should replace a
  // dead owner's file, but confirm that the file we moved is the one we verified.
  const moved = await snapshotLockFile(target);
  if (moved && moved.dev === expected.dev && moved.ino === expected.ino && moved.raw === expected.raw) {
    return "moved";
  }
  // Not the file we verified. Restore it with link(), which fails rather than
  // overwrite if a new lock appeared at `path` in the meantime.
  try {
    await fs.link(target, path);
    await fs.unlink(target).catch(() => {});
  } catch (error) {
    throw new BackgroundJobError(
      "storage-unavailable",
      `Stale-lock recovery moved a lock that changed underneath it and could not restore it: ${path} ` +
        `(preserved at ${target}; ${String((error as Error).message ?? error)})`,
    );
  }
  return "changed";
}

/**
 * Try to recover `path` after a `lock-held` failure. Returns true when the
 * caller should retry the O_EXCL acquisition once: either the stale file was
 * quarantined, or it had already disappeared. Returns false (meaning keep
 * `lock-held`) when the owner is alive or unverifiable, or when another
 * recoverer is busy.
 *
 * Exported for WP-11's lifetime daemon lock (D9), so it doesn't have to
 * reimplement the race handling.
 */
export async function tryRecoverStaleLock(
  root: string,
  path: string,
  adapter?: PlatformAdapter,
  probes?: Partial<LockOwnerProbes>,
): Promise<boolean> {
  const platformAdapter = adapter ?? (await getPlatformAdapter());
  const quarantine = quarantineDir(root);
  const guardPath = `${path}.recovery`;

  let releaseGuard: () => Promise<void>;
  try {
    releaseGuard = await platformAdapter.acquireLock(guardPath);
  } catch (error) {
    if (!isLockHeld(error)) throw error;
    // Another recoverer is active, or one crashed while holding the guard.
    // A guard whose owner is verified gone is moved aside so a LATER attempt
    // can proceed. This attempt still reports lock-held.
    const guard = await snapshotLockFile(guardPath);
    if (guard?.holder && (await isLockOwnerGone(guard.holder, probes))) {
      await quarantineIfUnchanged(guardPath, guard, quarantine).catch(() => {});
    }
    return false;
  }

  try {
    // Re-read under the guard: an earlier recoverer may already have replaced the file.
    const snapshot = await snapshotLockFile(path);
    if (!snapshot) {
      // Disappeared (released / recovered) or unreadable. Retrying the O_EXCL
      // create is safe either way, because it only succeeds if no file exists.
      return true;
    }
    if (!snapshot.holder) return false; // empty/corrupt: unverifiable, stay locked
    if (!(await isLockOwnerGone(snapshot.holder, probes))) return false;
    const outcome = await quarantineIfUnchanged(path, snapshot, quarantine);
    return outcome !== "changed";
  } finally {
    await releaseGuard();
  }
}

/** `adapter.acquireLock(path)` with one verified-gone recovery attempt on `lock-held`. */
async function acquireWithStaleRecovery(
  adapter: PlatformAdapter,
  root: string,
  path: string,
): Promise<() => Promise<void>> {
  try {
    return await adapter.acquireLock(path);
  } catch (error) {
    if (!isLockHeld(error)) throw error;
    if (!(await tryRecoverStaleLock(root, path, adapter))) throw error;
    return adapter.acquireLock(path); // exactly one retry; lock-held propagates
  }
}

async function withNamedLock<T>(root: string, name: string, fn: () => Promise<T>): Promise<T> {
  const current = lockContext.getStore();

  // Reentrant case: this exact lock is already held by an outer frame in the
  // same logical call stack — run directly, no second OS-level acquisition.
  if (current?.held.has(name)) {
    return fn();
  }

  const adapter = await getPlatformAdapter();
  const path = lockPath(root, name);
  const release = await acquireWithStaleRecovery(adapter, root, path);
  const next: LockContext = { held: new Set(current?.held ?? []) };
  next.held.add(name);
  try {
    return await lockContext.run(next, fn);
  } finally {
    await release();
  }
}

/** Acquire the per-job lifecycle lock, run `fn`, then always release. Reentrant within one call stack. */
export async function withJobLock<T>(root: string, jobId: string, fn: () => Promise<T>): Promise<T> {
  return withNamedLock(root, `job-${jobId}`, fn);
}

/** Acquire the single coordinator-wide writer lock, run `fn`, then always release. Reentrant within one call stack. */
export async function withCoordinatorLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withNamedLock(root, "coordinator", fn);
}
