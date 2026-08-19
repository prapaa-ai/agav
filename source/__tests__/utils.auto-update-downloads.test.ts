import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// auto-update.ts resolves ~/.agav once at import time, so the fake home has to
// exist and be installed before the module is first evaluated.
const home = await mkdtemp(join(tmpdir(), "agav-home-"));
const agavDir = join(home, ".agav");
await mkdir(agavDir, { recursive: true });

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: actual, homedir: () => home };
});

const { cleanupStaleDownloads } = await import("../utils/auto-update.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** Write a file into the fake ~/.agav and backdate it by `ageMs`. */
async function seed(name: string, ageMs: number): Promise<void> {
  const path = join(agavDir, name);
  await writeFile(path, "x");
  const when = new Date(NOW - ageMs);
  const { utimes } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await utimes(path, when, when);
}

beforeEach(async () => {
  for (const entry of await readdir(agavDir)) {
    await rm(join(agavDir, entry), { recursive: true, force: true });
  }
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("cleanupStaleDownloads", () => {
  // A process killed mid-transfer leaves a partial ~100 MB file in ~/.agav and
  // nothing ever collected it.
  it("removes abandoned downloads", async () => {
    await seed("agav-update-v0.1.7.4242", 2 * DAY_MS);
    await seed("agav-update-v0.1.6.99", 8 * DAY_MS);

    await cleanupStaleDownloads(NOW);

    expect(await readdir(agavDir)).toEqual([]);
  });

  // Age, not pid: a concurrently running agav may be mid-download, and yanking
  // its temp file would fail its update for no reason.
  it("leaves a download that could still be in flight", async () => {
    await seed("agav-update-v0.1.8.1234", 30 * 1000);

    await cleanupStaleDownloads(NOW);

    expect(await readdir(agavDir)).toEqual(["agav-update-v0.1.8.1234"]);
  });

  it("never touches anything that is not a download", async () => {
    await seed("config.json", 30 * DAY_MS);
    await seed("update-state.json", 30 * DAY_MS);
    await seed("prompt-history.json", 30 * DAY_MS);

    await cleanupStaleDownloads(NOW);

    expect((await readdir(agavDir)).sort()).toEqual([
      "config.json",
      "prompt-history.json",
      "update-state.json",
    ]);
  });

  it("skips directories that happen to match the prefix", async () => {
    await mkdir(join(agavDir, "agav-update-cache"), { recursive: true });

    await cleanupStaleDownloads(NOW);

    expect(await readdir(agavDir)).toEqual(["agav-update-cache"]);
  });

  it("never throws when ~/.agav does not exist yet", async () => {
    await rm(agavDir, { recursive: true, force: true });

    await expect(cleanupStaleDownloads(NOW)).resolves.toBeUndefined();

    await mkdir(agavDir, { recursive: true });
  });
});
