import { platform as osPlatform } from "node:os";
import type { PlatformAdapter } from "../types.js";
import { BackgroundJobError } from "../types.js";
import { processGroupHasLiveMembersPosix, readProcessStartTimePosix } from "./posix-common.js";

let cached: PlatformAdapter | null = null;

export async function getPlatformAdapter(): Promise<PlatformAdapter> {
  if (cached) return cached;
  const p = osPlatform();
  let adapter: PlatformAdapter;
  if (p === "linux") {
    adapter = (await import("./linux.js")).platformAdapter;
  } else if (p === "darwin") {
    adapter = (await import("./macos.js")).platformAdapter;
  } else if (p === "win32") {
    adapter = (await import("./windows.js")).platformAdapter;
  } else {
    throw new BackgroundJobError("unsupported-platform", `Background jobs are not supported on platform "${p}".`);
  }
  cached = adapter;
  return adapter;
}

// Liveness helpers for stale-lock recovery (storage/single-writer-lock.ts); not
// PlatformAdapter members because the adapter contract has no lock-holder probe.

/**
 * False only on positive evidence that no process with `pid` exists
 * (`kill(pid, 0)` → ESRCH). EPERM means the process exists but belongs to
 * someone else, so it's alive. Any other error is treated as alive too: when
 * in doubt, never recover the lock. Node implements signal 0 on every OS.
 */
export async function lockOwnerPidExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Same format the POSIX lock writer records. `undefined` on Windows (no probe without a native addon): callers must treat that as "cannot detect reuse". */
export async function readLockOwnerStartTime(pid: number): Promise<string | undefined> {
  if (osPlatform() === "win32") return undefined;
  return readProcessStartTimePosix(pid);
}

/**
 * Whether the owned scope still has live members after the direct child exited.
 * Only POSIX `process-group` scopes are probed; others (notably Windows) report
 * `false`, i.e. "nothing known to be left". Probe errors other than ESRCH/EPERM propagate.
 */
export async function ownedScopeHasLiveMembers(ownershipHandle: string, ownershipScope: string): Promise<boolean> {
  if (osPlatform() === "win32" || ownershipScope !== "process-group") return false;
  const pgid = Number(ownershipHandle);
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  return processGroupHasLiveMembersPosix(pgid);
}

/** Test-only override. */
export function __setPlatformAdapterForTests(adapter: PlatformAdapter | null): void {
  cached = adapter;
}
