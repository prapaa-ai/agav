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
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Resolve symlinks and verify the path exists; throws ENOENT-style errors otherwise. */
export async function canonicalizePathPosix(path: string): Promise<string> {
  return realpath(path);
}

/**
 * Exclusive lock using O_EXCL file creation — a stable lock object that is
 * never deleted/replaced while held (solution.md §7: "Stable lock objects
 * must not be deleted/replaced while held. A stale timestamp is not
 * permission to steal ownership.").
 *
 * The lock file contains the holder's pid and an ISO timestamp purely for
 * diagnostics; staleness is never used to seize the lock. Only an explicit
 * recovery flow (T12) may remove an abandoned lock after independently
 * verifying the owner process is gone.
 */
export async function acquireExclusiveLockPosix(lockPath: string): Promise<() => Promise<void>> {
  await fs.mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
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
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
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

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
