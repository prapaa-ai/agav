import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { getAgavDir } from "../../config/config.js";
import { BACKGROUND_JOBS_STORAGE_VERSION, BackgroundJobError } from "../types.js";
import { getPlatformAdapter } from "../platform/index.js";
import { writeAtomic } from "./atomic-file.js";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Best-effort: network/shared storage is unsupported (locking/publication semantics unverified). */
function looksLikeNetworkPath(path: string): boolean {
  return path.startsWith("\\\\") || path.includes("://");
}

function assertSafeId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || !SAFE_ID_PATTERN.test(id)) {
    throw new BackgroundJobError("not-found", `Invalid or unsafe identifier: ${JSON.stringify(id)}`);
  }
}

export function defaultStorageRoot(): string {
  return join(getAgavDir(), "background-jobs");
}

/** Creates the root (0700) if missing and canonicalizes it, resolving symlinks/junctions. */
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

// Every path is derived inside `root`; ids are validated so they cannot traverse outside it.

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

export function storageVersionPath(root: string): string {
  return join(root, "VERSION");
}

/** `undefined` for stores that predate the marker; a non-integer file throws rather than being guessed at. */
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

/** Never rewrites an existing marker, so a store from a newer build keeps its version. */
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

/** Throws `store-version-newer` if the store is newer than this build; a missing marker is accepted. */
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

/** An exact id match wins over prefix matches; no match or several prefix matches throw. */
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
