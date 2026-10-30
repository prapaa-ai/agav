import { readFile, writeFile, unlink } from "node:fs/promises";
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

/**
 * Persist the launch state, preserving any fields not being updated. The version
 * is always recorded; `autoShowChangelog` is carried through unless overridden,
 * so recording a new version never resets the user's auto-display preference.
 */
async function saveLaunchState(version: string, overrides: Partial<LaunchState> = {}): Promise<void> {
  await ensureDir(getAgavDir());
  const existing = await loadLaunchState();
  const state: LaunchState = {
    ...(existing ?? {}),
    lastLaunchedVersion: version,
    ...overrides,
  };
  await writeFile(STATE_FILE, JSON.stringify(state));
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
    await saveLaunchState(
      (await loadLaunchState())?.lastLaunchedVersion ?? VERSION,
      { autoShowChangelog: enabled },
    );
    return true;
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

    // An existing installation moved to a different version — record the new
    // version so later launches stay quiet regardless of the preference.
    await saveLaunchState(currentVersion);
    // Honor the user's opt-out: an update still advances the baseline, but the
    // changelog is only surfaced when auto-display is enabled.
    return state.autoShowChangelog !== false;
  } catch {
    // Never let version/display-state failures disrupt startup.
    return false;
  }
}
