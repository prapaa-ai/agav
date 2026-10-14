/**
 * T05 — Same-filesystem atomic publication primitives.
 *
 * Per solution.md §7: "Use same-filesystem atomic publication with declared
 * flush/durability behavior... Handle Windows sharing violations with
 * bounded retries; retain the last good record. Do not acknowledge
 * unpersisted operations." and "Quarantine corrupt records visibly instead
 * of reporting an empty successful list."
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { BackgroundJobError } from "../types.js";

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 50;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write `data` to `path` atomically: write to a sibling temp file in the
 * same directory, fsync it, then rename over the destination. On POSIX this
 * rename is atomic on the same filesystem. On Windows, rename-over-existing
 * can transiently fail with EPERM/EBUSY/EACCES while another handle is open
 * ("sharing violation"); retry a bounded number of times before giving up.
 *
 * Never silently drops a failed write — on exhausted retries this throws
 * `storage-unavailable` so callers never "acknowledge unpersisted operations".
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "w", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
    try {
      await fs.rename(tmpPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        await sleep(RENAME_RETRY_DELAY_MS);
        continue;
      }
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  await fs.unlink(tmpPath).catch(() => {});
  throw new BackgroundJobError(
    "storage-unavailable",
    `Failed to publish ${path} after ${RENAME_RETRY_ATTEMPTS} attempts: ${String(lastError)}`,
  );
}

/**
 * Read and JSON-parse `path`. Returns `undefined` if the file does not
 * exist. On parse failure (corrupt record), the file is moved aside into
 * `<quarantineDir>/` with a timestamped suffix and a `storage-unavailable`
 * error is thrown — callers must never silently treat a corrupt record as
 * an empty/missing one (solution.md §7).
 */
export async function readJsonIfExists<T>(path: string, quarantineDir?: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    await quarantine(path, quarantineDir);
    throw new BackgroundJobError(
      "storage-unavailable",
      `Corrupt record quarantined: ${path} (${String((error as Error).message ?? error)})`,
    );
  }
}

/**
 * Create a new file exclusively (fails if it already exists) and fsync it.
 * Used for records whose "already exists" outcome is expected/benign
 * (e.g. schedule-occurrence reservations) rather than an error — callers
 * get a boolean instead of a thrown error for the EEXIST case.
 *
 * The full contents are written and fsynced to a sibling temp file first,
 * then published with `link(tmp, path)`, which fails with EEXIST if the
 * destination exists and never replaces it. A reader therefore can never
 * observe a partially written (or empty) file at `path`. The temp file is
 * always unlinked afterwards.
 *
 * Fallback: on filesystems without hard-link support (EPERM/ENOTSUP/ENOSYS/
 * EXDEV) we fall back to `open(path, "wx")`. `rename` is deliberately NOT
 * used because it would replace an existing record. The fallback keeps
 * exclusivity but cannot guarantee readers never see the file before its
 * contents are written.
 */
export async function createExclusive(path: string, data: string): Promise<boolean> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    handle = undefined;
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
  await handle.close().catch(() => {});

  try {
    await fs.link(tmpPath, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await fs.unlink(tmpPath).catch(() => {});
      return false;
    }
    if (code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EXDEV") {
      await fs.unlink(tmpPath).catch(() => {});
      return createExclusiveWithoutLink(path, data);
    }
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
  await fs.unlink(tmpPath).catch(() => {});

  // Best-effort directory fsync so the new directory entry is durable.
  try {
    const dirHandle = await fs.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close().catch(() => {});
    }
  } catch {
    // Not supported on every platform (e.g. Windows); ignore.
  }
  return true;
}

/** Fallback for filesystems without hard links: exclusive create, never replaces an existing file. */
async function createExclusiveWithoutLink(path: string, data: string): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/** Move a corrupt file aside into `quarantineDir` (or a sibling `quarantine/` dir) instead of deleting it. */
export async function quarantine(path: string, quarantineDirOverride?: string): Promise<string> {
  const targetDir = quarantineDirOverride ?? join(dirname(path), "quarantine");
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 }).catch(() => {});
  const targetPath = join(targetDir, `${pathBasename(path)}.corrupt-${Date.now()}`);
  try {
    await fs.rename(path, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return targetPath;
}

function pathBasename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}
