import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgavDir } from "../config/config.js";
import { tick, type TickDeps } from "./schedule-run.js";
import type { TickDecision } from "./schedule-plan.js";

/**
 * A headless scheduler that runs without an interactive session.
 *
 * The tick logic is not duplicated here: `tick` is already shared with the
 * interactive ticker, and its default dependencies start detached jobs and
 * background commands. The daemon only owns the loop, a single-instance lock,
 * and a stop file — so it cannot drift from an interactive session.
 */

/** How often to evaluate. Matches the interactive ticker. */
export const DEFAULT_POLL_MS = 30_000;

export interface DaemonRecord {
  id: string;
  pid: number;
  startedAt: string;
  version: number;
}

export interface DaemonOptions {
  /** Overrides the poll interval. */
  pollMs?: number;
  /** Injectable for tests. */
  now?: () => Date;
  tickDeps?: TickDeps;
  /** Called with each tick's outcome. */
  onTick?: (decisions: TickDecision[]) => void;
  /** Injected so a test need not touch the real filesystem. */
  paths?: DaemonPaths;
}

export interface DaemonPaths {
  daemonFile: string;
  lockFile: string;
  logFile: string;
}

export function daemonPaths(): DaemonPaths {
  const dir = getAgavDir();
  return {
    daemonFile: join(dir, "scheduler-daemon.json"),
    lockFile: join(dir, "scheduler-daemon.lock"),
    logFile: join(dir, "scheduler.log"),
  };
}

/** Whether a pid is still running. Kept local so the module has no process deps. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running daemon, or null when the record is missing or stale. */
export async function readDaemonRecord(paths: DaemonPaths = daemonPaths()): Promise<DaemonRecord | null> {
  try {
    const record = JSON.parse(await readFile(paths.daemonFile, "utf8")) as DaemonRecord;
    if (!record || typeof record.pid !== "number") return null;
    // A record whose process is gone is stale: a crashed daemon must not make a
    // new one look like a duplicate, which would leave scheduling permanently off.
    return pidAlive(record.pid) ? record : null;
  } catch {
    return null;
  }
}

async function logLine(paths: DaemonPaths, message: string): Promise<void> {
  const stamp = new Date().toISOString();
  try {
    await mkdir(getAgavDir(), { recursive: true });
    await appendFile(paths.logFile, `${stamp} ${message}\n`, "utf8");
  } catch {
    // Logging must never take the daemon down.
  }
}

/**
 * Run the scheduler loop until stopped.
 *
 * Single-instance: writes a record containing its pid, and refuses to start if a
 * live daemon already owns the schedule. Two daemons would each tick every
 * minute, and although `tick` is safe to call often, duplicated reporting and
 * launch attempts are noise at best.
 */
export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const paths = options.paths ?? daemonPaths();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? (() => new Date());

  const existing = await readDaemonRecord(paths);
  if (existing) {
    throw new Error(`A scheduler daemon is already running (pid ${existing.pid}).`);
  }

  const record: DaemonRecord = {
    id: randomUUID(),
    pid: process.pid,
    startedAt: now().toISOString(),
    version: 1,
  };

  try {
    await mkdir(getAgavDir(), { recursive: true });
    await writeFile(paths.daemonFile, JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    throw new Error(`Could not record the daemon: ${err instanceof Error ? err.message : String(err)}`);
  }

  await logLine(paths, `daemon started (pid ${process.pid}, poll ${pollMs}ms)`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void logLine(paths, "daemon stopping");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Evaluated immediately so a fire missed while nothing was running is caught
  // on startup rather than waiting a whole interval.
  await evaluate();

  const timer = setInterval(() => {
    void evaluate();
  }, pollMs);
  timer.unref?.();

  await new Promise<void>((resolve) => {
    const finish = () => {
      clearInterval(timer);
      process.removeListener("SIGINT", finish);
      process.removeListener("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });

  await cleanupRecord(paths, record);
  await logLine(paths, "daemon stopped");

  /** One evaluation. A failure is logged and the loop continues. */
  async function evaluate(): Promise<void> {
    try {
      const decisions = await tick({
        ...options.tickDeps,
        now,
        // Headless: there is no session to print into, so the log is the record.
        report: options.tickDeps?.report ?? ((message, isError) => {
          void logLine(paths, `${isError ? "error" : "info"}: ${message}`);
        }),
      });
      const fired = decisions.filter((d) => d.fire).length;
      if (fired > 0) await logLine(paths, `fired ${fired} of ${decisions.length} task(s)`);
      options.onTick?.(decisions);
    } catch (err) {
      // One bad tick must not end the daemon: the schedule would then never run
      // again, with nothing to signal it.
      await logLine(paths, `tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Remove the record, but only if this process still owns it. */
async function cleanupRecord(paths: DaemonPaths, record: DaemonRecord): Promise<void> {
  try {
    const current = JSON.parse(await readFile(paths.daemonFile, "utf8")) as DaemonRecord;
    if (current.id === record.id) {
      await rmFile(paths.daemonFile);
    }
  } catch {
    // Already gone.
  }
}

/** Ask a running daemon to exit, and report whether one was signalled. */
export async function stopDaemon(paths: DaemonPaths = daemonPaths()): Promise<DaemonRecord | null> {
  const record = await readDaemonRecord(paths);
  if (!record) return null;
  try {
    // Windows cannot deliver SIGTERM meaningfully, but Node maps it to a
    // terminate for a child we own; the handler clears up where it can.
    process.kill(record.pid, "SIGTERM");
    return record;
  } catch {
    return null;
  }
}

async function rmFile(path: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  await unlink(path);
}