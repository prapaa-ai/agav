/**
 * WP-06 (plan item 0.10, decision D6) — store VERSION marker.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkStorageVersion,
  ensureStorageVersionFile,
  readStorageVersion,
  resolveStorageRoot,
  storageVersionPath,
} from "../storage/paths.js";
import { createCoordinator } from "../coordinator/service.js";
import { BACKGROUND_JOBS_STORAGE_VERSION, BackgroundJobError } from "../types.js";

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-bg-version-"));
  root = await resolveStorageRoot(base);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("storage VERSION file (0.10)", () => {
  it("storageVersionPath is <root>/VERSION", () => {
    expect(storageVersionPath(root)).toBe(join(root, "VERSION"));
  });

  it("resolving a storage root alone does not write VERSION", async () => {
    expect(await readStorageVersion(root)).toBeUndefined();
  });

  it("createCoordinator writes the current version when absent", async () => {
    await createCoordinator({ root });
    expect(await readFile(storageVersionPath(root), "utf8")).toBe(`${BACKGROUND_JOBS_STORAGE_VERSION}\n`);
    expect(await readStorageVersion(root)).toBe(BACKGROUND_JOBS_STORAGE_VERSION);
  });

  it("leaves no temp files behind", async () => {
    await ensureStorageVersionFile(root);
    expect((await readdir(root)).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  });

  it("never rewrites an existing VERSION (e.g. one written by a newer build)", async () => {
    await writeFile(storageVersionPath(root), "7\n");
    await createCoordinator({ root }).catch(() => {});
    await ensureStorageVersionFile(root);
    expect(await readFile(storageVersionPath(root), "utf8")).toBe("7\n");
  });

  it("createCoordinator rejects a store stamped by a newer build with store-version-newer", async () => {
    const newer = `${BACKGROUND_JOBS_STORAGE_VERSION + 1}\n`;
    await writeFile(storageVersionPath(root), newer);
    const error = await createCoordinator({ root }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackgroundJobError);
    expect((error as BackgroundJobError).code).toBe("store-version-newer");
    expect(await readFile(storageVersionPath(root), "utf8")).toBe(newer);
  });

  it("createCoordinator accepts an existing supported VERSION and an absent one", async () => {
    await expect(createCoordinator({ root })).resolves.toBeDefined(); // absent → stamped
    await expect(createCoordinator({ root })).resolves.toBeDefined(); // existing current version
    expect(await readStorageVersion(root)).toBe(BACKGROUND_JOBS_STORAGE_VERSION);
  });

  it("is idempotent", async () => {
    await ensureStorageVersionFile(root);
    await ensureStorageVersionFile(root);
    expect(await readStorageVersion(root)).toBe(BACKGROUND_JOBS_STORAGE_VERSION);
  });

  it("checkStorageVersion accepts a missing file (legacy store)", async () => {
    await expect(checkStorageVersion(root)).resolves.toBeUndefined();
  });

  it("checkStorageVersion accepts the supported version", async () => {
    await ensureStorageVersionFile(root);
    await expect(checkStorageVersion(root)).resolves.toBe(BACKGROUND_JOBS_STORAGE_VERSION);
  });

  it("checkStorageVersion throws store-version-newer for a newer store", async () => {
    await writeFile(storageVersionPath(root), `${BACKGROUND_JOBS_STORAGE_VERSION + 1}\n`);
    const error = await checkStorageVersion(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackgroundJobError);
    expect((error as BackgroundJobError).code).toBe("store-version-newer");
    expect((error as Error).message).toContain(String(BACKGROUND_JOBS_STORAGE_VERSION + 1));
  });

  it.each(["", "abc", "1.5", "-1", "0", "2x"])("rejects a non-numeric/invalid VERSION %j with a clear error", async (contents) => {
    await writeFile(storageVersionPath(root), contents);
    await expect(checkStorageVersion(root)).rejects.toMatchObject({
      code: "storage-unavailable",
      message: expect.stringContaining("not a valid version number"),
    });
  });
});
