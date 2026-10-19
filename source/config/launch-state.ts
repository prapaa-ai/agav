import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAgavDir } from "./config.js";
import { ensureDir } from "../utils/fs.js";
import { VERSION } from "../version.js";

interface LaunchState {
  /** The Agav version recorded on the most recent interactive launch. */
  lastLaunchedVersion: string;
}

const STATE_FILE = join(getAgavDir(), "launch-state.json");

/** Validate that a parsed object has the expected LaunchState shape. */
function isValidLaunchState(value: unknown): value is LaunchState {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.lastLaunchedVersion === "string" && obj.lastLaunchedVersion.length > 0;
}

async function loadLaunchState(): Promise<LaunchState | null> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    if (!isValidLaunchState(state)) {
      // Treat a corrupt file as a fresh baseline rather than letting it wedge
      // the update-detection logic forever. Remove it so the next launch is clean.
      try { await unlink(STATE_FILE); } catch {}
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

async function saveLaunchState(version: string): Promise<void> {
  await ensureDir(getAgavDir());
  const state: LaunchState = { lastLaunchedVersion: version };
  await writeFile(STATE_FILE, JSON.stringify(state));
}

/**
 * Record this interactive launch's version and report whether the changelog
 * should be shown once for it.
 *
 * Returns true only when an *existing* installation's recorded version differs
 * from the running version (an update). A fresh installation establishes the
 * baseline silently and returns false; subsequent launches of the same version
 * also return false. Persisting the new version here means the pending display
 * is consumed exactly once — restarting Agav will not show it again.
 *
 * Never throws: changelog retrieval or local-state failures must not block or
 * crash startup. On any failure it returns false and shows nothing.
 *
 * Call this only from interactive startup so non-interactive runs neither
 * display the changelog nor consume the pending first-interactive-launch display.
 */
export async function consumeChangelogDisplay(currentVersion: string = VERSION): Promise<boolean> {
  try {
    const state = await loadLaunchState();

    // Fresh installation: establish the baseline without showing a changelog.
    if (!state) {
      await saveLaunchState(currentVersion);
      return false;
    }

    // Same version as last interactive launch: nothing new to show.
    if (state.lastLaunchedVersion === currentVersion) {
      return false;
    }

    // An existing installation moved to a different version — show the
    // changelog once and record the new version so later launches stay quiet.
    await saveLaunchState(currentVersion);
    return true;
  } catch {
    // Never let version/display-state failures disrupt startup.
    return false;
  }
}
