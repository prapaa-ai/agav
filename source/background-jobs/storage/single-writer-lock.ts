/**
 * T05 — Single-writer lock helpers.
 *
 * Wraps `PlatformAdapter.acquireLock` to provide "single lifecycle writer
 * per job" and "single coordinator writer" guarantees described in
 * solution.md §7. On `lock-held` from a DIFFERENT call stack this never
 * retries or steals the lock — recovery/takeover after independently
 * verifying the owner is gone is T12's responsibility, not storage's.
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
import { getPlatformAdapter } from "../platform/index.js";
import { lockPath } from "./paths.js";

interface LockContext {
  /** Lock names currently held by this (possibly nested) call stack. */
  held: Set<string>;
}

const lockContext = new AsyncLocalStorage<LockContext>();

async function withNamedLock<T>(root: string, name: string, fn: () => Promise<T>): Promise<T> {
  const current = lockContext.getStore();

  // Reentrant case: this exact lock is already held by an outer frame in the
  // same logical call stack — run directly, no second OS-level acquisition.
  if (current?.held.has(name)) {
    return fn();
  }

  const adapter = await getPlatformAdapter();
  const release = await adapter.acquireLock(lockPath(root, name));
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
