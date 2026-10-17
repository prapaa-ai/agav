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
 * Temp file + fsync + rename. Windows can transiently refuse rename-over-existing (EPERM/EBUSY/EACCES)
 * while another handle is open, so it is retried; exhausted retries throw `storage-unavailable`.
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

/** A corrupt record is quarantined and throws `storage-unavailable` rather than reading as missing. */
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
 * Returns false (not an error) when `path` already exists. Contents are fsynced to a temp file and
 * published with `link()`, so a reader never sees a partial or empty file at `path`.
 *
 * Fails closed: if the filesystem cannot hard-link (EPERM/ENOTSUP/ENOSYS/EXDEV) this throws
 * `storage-unavailable` instead of falling back to `open(path, "wx")`, which would expose an empty
 * file that a reader could quarantine, allowing a duplicate launch. `rename` would replace an existing record.
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
      throw new BackgroundJobError(
        "storage-unavailable",
        `Exclusive atomic publication is unsupported on this filesystem (link: ${code}); ` +
          `cannot safely create ${path}`,
      );
    }
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
  await fs.unlink(tmpPath).catch(() => {});

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
