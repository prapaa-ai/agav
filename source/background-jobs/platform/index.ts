/**
 * Platform adapter selector — owned by T01 (integration lead).
 *
 * T02/T03/T04 each implement and export a `platformAdapter: PlatformAdapter`
 * from their own file (`linux.ts`, `macos.ts`, `windows.ts`) and MUST NOT
 * edit this selector. This indirection keeps `platform/*` files mutually
 * independent (no agent needs to touch another OS's file to get picked up).
 */
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

/**
 * Liveness helpers used by stale-lock recovery (`storage/single-writer-lock.ts`).
 * They are plain functions rather than `PlatformAdapter` members because the
 * frozen adapter contract in types.ts has no lock-holder probe.
 */

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

/**
 * Best-effort process start time for PID-reuse detection, in the same format
 * the POSIX lock writer records. Windows has no start-time probe without a
 * native addon (see windows.ts limitations), so it returns `undefined` there,
 * and callers must treat that as "cannot detect reuse".
 */
export async function readLockOwnerStartTime(pid: number): Promise<string | undefined> {
  if (osPlatform() === "win32") return undefined;
  return readProcessStartTimePosix(pid);
}

/**
 * Whether the owned workload scope still has live members after the direct
 * child has exited. Only meaningful for POSIX `process-group` scopes (the
 * workload is spawned detached, so its pgid equals the handle pid); every other
 * scope (notably Windows, which has no verifiable group) reports `false`, i.e.
 * "nothing known to be left", preserving the prior direct-child-only behavior.
 * Probe failures other than ESRCH/EPERM propagate to the caller.
 */
export async function ownedScopeHasLiveMembers(ownershipHandle: string, ownershipScope: string): Promise<boolean> {
  if (osPlatform() === "win32" || ownershipScope !== "process-group") return false;
  const pgid = Number(ownershipHandle);
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  return processGroupHasLiveMembersPosix(pgid);
}

/** Test-only override so unit tests can inject a fake adapter without mocking node:os. */
export function __setPlatformAdapterForTests(adapter: PlatformAdapter | null): void {
  cached = adapter;
}
