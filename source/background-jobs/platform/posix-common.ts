/**
 * Shared POSIX primitives usable by both the Linux (T02) and macOS (T03)
 * adapters. Owned by T01 so T02/T03 coordinate changes here instead of
 * importing each other's adapter files directly (subtasks.md T03 note:
 * "Coordinate shared POSIX primitives through T01's owner rather than
 * editing T02's files").
 *
 * Nothing here is OS-specific; `linux.ts` and `macos.ts` should prefer these
 * helpers over duplicating logic, and extend/override only where Linux and
 * macOS genuinely diverge (e.g. cgroups are Linux-only).
 */
import { constants, promises as fs } from "node:fs";
import { realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Resolve symlinks and verify the path exists; throws ENOENT-style errors otherwise. */
export async function canonicalizePathPosix(path: string): Promise<string> {
  return realpath(path);
}

/**
 * The current process's start time never changes, so read it once per
 * process (on macOS `readProcessStartTimePosix` spawns `ps`, which would
 * otherwise run on every lock acquisition).
 */
let ownStartTime: Promise<string | undefined> | undefined;
function readOwnProcessStartTime(): Promise<string | undefined> {
  ownStartTime ??= readProcessStartTimePosix(process.pid).catch(() => undefined);
  return ownStartTime;
}

/**
 * Exclusive lock using O_EXCL file creation — a stable lock object that is
 * never deleted/replaced while held (solution.md §7: "Stable lock objects
 * must not be deleted/replaced while held. A stale timestamp is not
 * permission to steal ownership.").
 *
 * The lock file records the holder's identity: `pid`, `processStartTime`
 * (from `readProcessStartTimePosix`, when readable) and `hostname`, plus an
 * ISO `acquiredAt` timestamp purely for diagnostics. Staleness (age) is
 * never used to seize the lock. This primitive itself never removes another
 * holder's lock: on EEXIST it throws `lock-held`. Recovery lives one layer
 * up (`storage/single-writer-lock.ts`, `isLockOwnerGone`) and only moves an
 * abandoned lock aside after independently verifying the owner process is
 * gone — same host, and the pid is dead or has been reused (start time
 * differs). A missing/corrupt holder record is never recovered.
 */
export async function acquireExclusiveLockPosix(lockPath: string): Promise<() => Promise<void>> {
  await fs.mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  // Read before the O_EXCL create so the window in which the lock file exists
  // but is still empty (which readers treat as "unverifiable, held") is short.
  const processStartTime = await readOwnProcessStartTime();
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      const { BackgroundJobError } = await import("../types.js");
      throw new BackgroundJobError("lock-held", `Lock already held: ${lockPath}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        ...(processStartTime !== undefined ? { processStartTime } : {}),
        hostname: hostname(),
      }),
    );
  } finally {
    await handle.close();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await fs.unlink(lockPath).catch(() => {});
  };
}

/** Best-effort boot/process-creation identity disambiguator for PID reuse detection. */
export async function readProcessStartTimePosix(pid: number): Promise<string | undefined> {
  try {
    // Linux: /proc/<pid>/stat field 22 is starttime (ticks since boot).
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    const fields = stat.slice(closeParen + 2).split(" ");
    const starttime = fields[19]; // index 21 overall minus (pid, comm) consumed
    if (starttime) return starttime;
  } catch {
    // Not Linux /proc, or process gone — fall through to the portable probe.
  }
  try {
    // Portable (Linux + macOS) fallback: ps exposes an elapsed/start field.
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
  } catch {
    // Process not found via ps either.
  }
  return undefined;
}

/** True when the pid exists at all (kill -0). Never sufficient alone to authorize a signal. */
export async function pidExistsPosix(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/** Send a signal to an entire process group (negative pid convention). */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * True while the process group `pgid` still has at least one live member.
 * `kill(-pgid, 0)`: ESRCH means the group is gone; EPERM means it exists but
 * is not signalable by us (still alive). Any other error is rethrown.
 *
 * Where `/proc` is available, members that are only zombies (exited but not
 * yet reaped, e.g. under a non-reaping PID 1) are not counted as live, so a
 * finished job is not held open forever. If `/proc` is unavailable (macOS) or
 * no member of the group can be positively classified, this conservatively
 * reports the group as alive.
 */
export async function processGroupHasLiveMembersPosix(pgid: number): Promise<boolean> {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code !== "EPERM") throw error;
  }
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return true;
  }
  let sawZombie = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = await fs.readFile(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // exited meanwhile, or not readable
    }
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) continue;
    const fields = stat.slice(closeParen + 2).split(" "); // [state, ppid, pgrp, ...]
    if (Number(fields[2]) !== pgid) continue;
    if (fields[0] === "Z" || fields[0] === "X") sawZombie = true;
    else return true;
  }
  return !sawZombie;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
