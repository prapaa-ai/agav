import { constants, promises as fs } from "node:fs";
import { realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function canonicalizePathPosix(path: string): Promise<string> {
  return realpath(path);
}

// Cached: own start time never changes, and on macOS reading it spawns `ps`.
let ownStartTime: Promise<string | undefined> | undefined;
function readOwnProcessStartTime(): Promise<string | undefined> {
  ownStartTime ??= readProcessStartTimePosix(process.pid).catch(() => undefined);
  return ownStartTime;
}

/**
 * O_EXCL lock file, never deleted/replaced while held; age is never grounds to
 * seize it (`acquiredAt` is diagnostic only). On EEXIST this throws `lock-held`.
 * Stale recovery lives in `storage/single-writer-lock.ts` and requires verifying
 * the owner is gone (same host; pid dead or reused). A missing/corrupt holder
 * record is never recovered.
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

/** Best-effort process start time, used to detect PID reuse. */
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
    // Portable fallback (macOS).
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

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * True while the process group still has a live member. With `/proc`, zombies
 * (e.g. unreaped under a non-reaping PID 1) don't count, so a finished job isn't
 * held open forever. Without `/proc` (macOS), conservatively reports alive.
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
