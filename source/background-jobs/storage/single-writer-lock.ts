/**
 * Single-writer locks. On `lock-held` a lock is recovered only when its owner is verified gone
 * (`isLockOwnerGone`): same host, and the pid is dead or reused. A missing/corrupt holder record
 * or lock age never allows recovery. The stale file is quarantined (never deleted) and acquisition
 * retried once; recoverers are serialized by a `<lock>.recovery` guard.
 *
 * Reentrant within one async call stack (via `AsyncLocalStorage`), because `jobs.update()` takes
 * the same per-job lock and callers need a read-decide-update critical section. Cross-stack and
 * cross-process exclusion is unchanged.
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
  held: Set<string>;
}

const lockContext = new AsyncLocalStorage<LockContext>();

/** Legacy lock files carry only `pid` + `acquiredAt`. */
export interface LockHolder {
  pid: number;
  acquiredAt?: string;
  /** Absent on Windows / legacy files. */
  processStartTime?: string;
  /** Absent on legacy files (treated as local). */
  hostname?: string;
}

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

/** One handle for both stat and content, so dev/ino and content belong to the same file. */
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

/** `undefined` means liveness is unverifiable; callers must never recover in that case. */
export async function readLockHolder(path: string): Promise<LockHolder | undefined> {
  return (await snapshotLockFile(path))?.holder;
}

/** True only on positive evidence the owner is gone; anything unverifiable yields false. */
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

function isLockHeld(error: unknown): boolean {
  return error instanceof BackgroundJobError && error.code === "lock-held";
}

/**
 * Quarantines `path` only if it is still the exact file in `expected`; never removes a different file.
 *
 * Link-first: a hard link `<path>.retire-<dev>-<ino>` claims the file currently at `path`. Its name is
 * unique per inode and the claim pins the inode, so only one caller claims a given stale file, and a
 * delayed caller with an old snapshot finds a mismatch and drops only its own claim. `path` is unlinked
 * only after the claimed file is verified to match the snapshot.
 *
 * Known unhandled case: a recoverer that crashes between claiming and unlinking leaves the claim behind,
 * so that stale file is not recovered until the claim is removed by hand. Without hard-link support
 * nothing is recovered (fails closed).
 */
async function quarantineIfUnchanged(
  path: string,
  expected: LockFileSnapshot,
  quarantine: string,
): Promise<"moved" | "missing" | "changed"> {
  await fs.mkdir(quarantine, { recursive: true, mode: 0o700 });
  const claim = `${path}.retire-${expected.dev}-${expected.ino}`;
  try {
    await fs.link(path, claim);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "EEXIST" || code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EXDEV") {
      return "changed";
    }
    throw error;
  }
  const claimed = await snapshotLockFile(claim);
  if (!claimed || claimed.dev !== expected.dev || claimed.ino !== expected.ino || claimed.raw !== expected.raw) {
    await fs.unlink(claim).catch(() => {});
    return "changed";
  }
  try {
    await fs.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await fs.unlink(claim).catch(() => {});
      throw error;
    }
  }
  await fs.rename(claim, join(quarantine, `${basename(path)}.stale-${Date.now()}-${randomUUID()}`));
  return "moved";
}

/**
 * True when the caller should retry the O_EXCL acquisition once (stale file quarantined or already
 * gone); false to keep `lock-held` (owner alive/unverifiable, or another recoverer is busy).
 * Exported for the daemon lock.
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

  // Reentrant: an outer frame in this call stack already holds this lock.
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
    // Detached callbacks inherit context, not ownership after release.
    next.held.delete(name);
    await release();
  }
}

export async function withJobLock<T>(root: string, jobId: string, fn: () => Promise<T>): Promise<T> {
  return withNamedLock(root, `job-${jobId}`, fn);
}

export async function withCoordinatorLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withNamedLock(root, "coordinator", fn);
}
