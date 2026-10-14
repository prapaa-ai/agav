/**
 * T05 — Storage root resolution, canonicalization and ID safety.
 *
 * Owned by T05 (storage/repositories). Per solution.md §7: "Resolve custom
 * storage roots to absolute paths and require local, private storage with
 * validated locking/publication semantics. Network/shared storage is outside
 * the baseline. IDs are not file paths; derive all paths inside the
 * validated root and reject unsafe links/junctions. Use full
 * collision-resistant IDs; every prefix-based action rejects ambiguity."
 */
import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { getAgavDir } from "../../config/config.js";
import { BACKGROUND_JOBS_STORAGE_VERSION, BackgroundJobError } from "../types.js";
import { getPlatformAdapter } from "../platform/index.js";
import { writeAtomic } from "./atomic-file.js";

/** Matches the "collision-resistant" identifiers this subsystem issues (uuid-ish). */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Reject obvious network/UNC-style paths; best-effort per solution.md §7. */
function looksLikeNetworkPath(path: string): boolean {
  return path.startsWith("\\\\") || path.includes("://");
}

function assertSafeId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || !SAFE_ID_PATTERN.test(id)) {
    throw new BackgroundJobError("not-found", `Invalid or unsafe identifier: ${JSON.stringify(id)}`);
  }
}

/** Default storage root: `<agav-dir>/background-jobs`, unless a custom root is supplied. */
export function defaultStorageRoot(): string {
  return join(getAgavDir(), "background-jobs");
}

/**
 * Resolve a storage root to an absolute, canonicalized, local path.
 *
 * Creates the directory (mode 0700) if it does not exist yet, then
 * canonicalizes it via the platform adapter (resolves symlinks/junctions and
 * verifies existence). Rejects paths that look like network/UNC shares.
 */
export async function resolveStorageRoot(customRoot?: string): Promise<string> {
  const requested = customRoot ?? defaultStorageRoot();
  if (looksLikeNetworkPath(requested)) {
    throw new BackgroundJobError(
      "storage-unavailable",
      `Network/shared storage roots are not supported: ${requested}`,
    );
  }
  const absolute = isAbsolute(requested) ? requested : resolve(requested);

  try {
    await fs.stat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  }

  const adapter = await getPlatformAdapter();
  const canonical = await adapter.canonicalizePath(absolute);
  if (looksLikeNetworkPath(canonical)) {
    throw new BackgroundJobError(
      "storage-unavailable",
      `Network/shared storage roots are not supported: ${canonical}`,
    );
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// Record path helpers — every path is derived inside `root`; ids are
// validated so they can never traverse outside it.
// ---------------------------------------------------------------------------

export function jobsDir(root: string): string {
  return join(root, "jobs");
}

export function specsDir(root: string): string {
  return join(root, "specs");
}

export function eventsDir(root: string): string {
  return join(root, "events");
}

export function acksDir(root: string): string {
  return join(root, "acks");
}

export function schedulesDir(root: string): string {
  return join(root, "schedules");
}

export function occurrencesDir(root: string): string {
  return join(root, "occurrences");
}

export function controlIntentsDir(root: string): string {
  return join(root, "control-intents");
}

export function locksDir(root: string): string {
  return join(root, "locks");
}

export function quarantineDir(root: string): string {
  return join(root, "quarantine");
}

export function jobPath(root: string, jobId: string): string {
  assertSafeId(jobId);
  return join(jobsDir(root), `${jobId}.json`);
}

export function specPath(root: string, requestId: string): string {
  assertSafeId(requestId);
  return join(specsDir(root), `${requestId}.json`);
}

export function eventPath(root: string, eventId: string): string {
  assertSafeId(eventId);
  return join(eventsDir(root), `${eventId}.json`);
}

export function ackPath(root: string, eventId: string, clientId: string): string {
  assertSafeId(eventId);
  assertSafeId(clientId);
  return join(acksDir(root), `${eventId}--${clientId}.json`);
}

export function schedulePath(root: string, scheduleId: string): string {
  assertSafeId(scheduleId);
  return join(schedulesDir(root), `${scheduleId}.json`);
}

export function occurrencePath(root: string, occurrenceId: string): string {
  assertSafeId(occurrenceId);
  return join(occurrencesDir(root), `${occurrenceId}.json`);
}

export function controlIntentPath(root: string, intentId: string): string {
  assertSafeId(intentId);
  return join(controlIntentsDir(root), `${intentId}.json`);
}

export function lockPath(root: string, name: string): string {
  assertSafeId(name);
  return join(locksDir(root), `${name}.lock`);
}

// ---------------------------------------------------------------------------
// Store VERSION marker (plan item 0.10, decision D6)
// ---------------------------------------------------------------------------

/** `<root>/VERSION`: plain-text integer storage version of this store. */
export function storageVersionPath(root: string): string {
  return join(root, "VERSION");
}

/**
 * Read the store's on-disk VERSION. Returns `undefined` when the file does
 * not exist (stores created by builds that predate the marker). A file that
 * isn't a positive integer is reported as `storage-unavailable` rather than
 * guessed at.
 */
export async function readStorageVersion(root: string): Promise<number | undefined> {
  const path = storageVersionPath(root);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed) || Number(trimmed) < 1 || !Number.isSafeInteger(Number(trimmed))) {
    throw new BackgroundJobError(
      "storage-unavailable",
      `Background-jobs store VERSION file is not a valid version number: ${path} (contents: ${JSON.stringify(trimmed.slice(0, 32))}).`,
    );
  }
  return Number(trimmed);
}

/**
 * Write the current storage version to `<root>/VERSION` if the file is
 * absent. An existing file is never rewritten, so a store created or
 * upgraded by a newer build keeps its marker. Writing the marker into an
 * older store that lacks one is harmless: on-disk record shapes are
 * unchanged at version 1. Publication is atomic temp+rename (`writeAtomic`),
 * so readers never observe a partial file; concurrent first-time writers
 * all publish the same content.
 */
export async function ensureStorageVersionFile(root: string): Promise<void> {
  const path = storageVersionPath(root);
  try {
    await fs.stat(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeAtomic(path, `${BACKGROUND_JOBS_STORAGE_VERSION}\n`);
}

/**
 * Throw `store-version-newer` when the on-disk VERSION is greater than the
 * version this build supports (`BACKGROUND_JOBS_STORAGE_VERSION`). A missing
 * file is accepted (legacy store). Returns the on-disk version, if any.
 */
export async function checkStorageVersion(root: string): Promise<number | undefined> {
  const version = await readStorageVersion(root);
  if (version !== undefined && version > BACKGROUND_JOBS_STORAGE_VERSION) {
    throw new BackgroundJobError(
      "store-version-newer",
      `Background-jobs store at ${root} has storage version ${version}, but this build supports up to ` +
        `version ${BACKGROUND_JOBS_STORAGE_VERSION}. Upgrade agav to use this store.`,
    );
  }
  return version;
}

/**
 * Resolve an unambiguous id from `ids` matching `prefix`. Exact full-id
 * matches take priority over prefix matches. Throws `not-found` when nothing
 * matches and `ambiguous-id` when more than one candidate matches.
 */
export function resolvePrefix(ids: string[], prefix: string): string {
  const exact = ids.find((id) => id === prefix);
  if (exact) return exact;

  const matches = ids.filter((id) => id.startsWith(prefix));
  if (matches.length === 0) {
    throw new BackgroundJobError("not-found", `No id matches prefix: ${prefix}`);
  }
  if (matches.length > 1) {
    throw new BackgroundJobError("ambiguous-id", `Prefix "${prefix}" matches multiple ids: ${matches.join(", ")}`);
  }
  return matches[0]!;
}
