import { randomUUID } from "node:crypto";
import { open, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAgavDir } from "./config.js";
import { ensureDir } from "../utils/fs.js";
import { VERSION } from "../version.js";

interface LaunchState {
  /** The Agav version recorded on the most recent interactive launch. */
  lastLaunchedVersion: string;
  /**
   * When explicitly false, the changelog is never shown automatically on the
   * first launch after an update. Unset (the default) means auto-display is on.
   * Toggled by the user via `/changelog off` / `/changelog on`.
   */
  autoShowChangelog?: boolean;
}

const STATE_FILE = join(getAgavDir(), "launch-state.json");
const LOCK_FILE = join(getAgavDir(), ".launch-state.lock");

/** Lock the entire transaction, including its first read, across all sessions. */
async function withLaunchStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureDir(getAgavDir());
  const deadline = Date.now() + 5_000;
  let handle;
  for (;;) {
    try {
      handle = await open(LOCK_FILE, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Match config/account locks: never steal a suspended owner's lock.
      // After a crash, stop all Agav processes before manually removing it.
      if (Date.now() >= deadline) throw new Error("Launch-state lock is held");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    try {
      await handle.writeFile(String(process.pid));
    } finally {
      await handle.close();
    }
    return await fn();
  } finally {
    await unlink(LOCK_FILE);
  }
}

/** Validate that a parsed object has the expected LaunchState shape. */
function isValidLaunchState(value: unknown): value is LaunchState {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.lastLaunchedVersion !== "string" || obj.lastLaunchedVersion.length === 0) return false;
  // autoShowChangelog is optional, but when present it must be a boolean.
  if (obj.autoShowChangelog !== undefined && typeof obj.autoShowChangelog !== "boolean") return false;
  return true;
}

async function loadLaunchState(): Promise<LaunchState | null> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    if (!isValidLaunchState(state)) {
      // Reads must not remove a file another session may have just replaced.
      // The next locked writer will replace the invalid state atomically.
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/** Called only under the launch-state lock; readers see old or new complete JSON. */
async function saveLaunchState(state: LaunchState): Promise<void> {
  const tmpPath = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await rename(tmpPath, STATE_FILE);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Whether the changelog is shown automatically on the first launch after an
 * update. Defaults to true; only an explicit `autoShowChangelog: false` disables
 * it. Never throws — on any failure it reports the default (enabled).
 */
export async function isChangelogAutoDisplayEnabled(): Promise<boolean> {
  try {
    const state = await loadLaunchState();
    return state?.autoShowChangelog !== false;
  } catch {
    return true;
  }
}

/**
 * Enable or disable automatic changelog display after updates. Persists the
 * choice without disturbing the recorded launch version. Never throws; returns
 * true on success and false if the preference could not be saved.
 */
export async function setChangelogAutoDisplay(enabled: boolean): Promise<boolean> {
  try {
    return await withLaunchStateLock(async () => {
      const state = await loadLaunchState();
      await saveLaunchState({
        ...state,
        lastLaunchedVersion: state?.lastLaunchedVersion ?? VERSION,
        autoShowChangelog: enabled,
      });
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Record this interactive launch's version and report whether the changelog
 * should be shown once for it.
 *
 * Returns true only when an *existing* installation's recorded version differs
 * from the running version (an update) AND the user has not disabled automatic
 * display. A fresh installation establishes the baseline silently and returns
 * false; subsequent launches of the same version also return false. Persisting
 * the new version here means the pending display is consumed exactly once —
 * restarting Agav will not show it again.
 *
 * Never throws: changelog retrieval or local-state failures must not block or
 * crash startup. On any failure it returns false and shows nothing.
 *
 * Call this only from interactive startup so non-interactive runs neither
 * display the changelog nor consume the pending first-interactive-launch display.
 */
export async function consumeChangelogDisplay(currentVersion: string = VERSION): Promise<boolean> {
  try {
    return await withLaunchStateLock(async () => {
      const state = await loadLaunchState();

      // Fresh installation: establish the baseline without showing a changelog.
      if (!state) {
        await saveLaunchState({ lastLaunchedVersion: currentVersion });
        return false;
      }

      if (state.lastLaunchedVersion === currentVersion) return false;

      // Advance the baseline even when opted out, preserving the preference.
      await saveLaunchState({ ...state, lastLaunchedVersion: currentVersion });
      return state.autoShowChangelog !== false;
    });
  } catch {
    // Never let version/display-state failures disrupt startup.
    return false;
  }
}
