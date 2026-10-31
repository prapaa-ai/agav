import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const home = await mkdtemp(join(tmpdir(), "agav-launch-persistence-"));
const dir = join(home, ".agav");
const statePath = join(dir, "launch-state.json");
const lockPath = join(dir, ".launch-state.lock");
const originalState = { lastLaunchedVersion: "0.3.0", autoShowChangelog: false };
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: actual, homedir: () => home };
});
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile), open: vi.fn(actual.open) };
});
const fs = await import("node:fs/promises");
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { consumeChangelogDisplay, setChangelogAutoDisplay, isChangelogAutoDisplayEnabled } = await import("../config/launch-state.js");
beforeEach(async () => {
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actualFs.writeFile);
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open);
  await mkdir(dir, { recursive: true });
  await writeFile(statePath, JSON.stringify(originalState));
});
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

it.each(["startup", "toggle"])("fails closed without touching a foreign lock during %s", async (operation) => {
  await writeFile(lockPath, "foreign-owner");
  // Keep real I/O and shorten only the clock deadline, not acquisition semantics.
  const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(5_001);
  try {
    expect(await (operation === "startup" ? consumeChangelogDisplay("0.3.1") : setChangelogAutoDisplay(true))).toBe(false);
  } finally { now.mockRestore(); }
  expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(originalState);
  expect(await readFile(lockPath, "utf8")).toBe("foreign-owner");
});

it.each(["write", "rename"])("preserves the previous state and cleans up after a failed %s", async (operation) => {
  if (operation === "write") {
    vi.mocked(fs.writeFile).mockImplementationOnce(async (path, data, options) => {
      await actualFs.writeFile(path, data, options);
      throw new Error("disk failure");
    });
  } else {
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failure"));
  }
  expect(await setChangelogAutoDisplay(true)).toBe(false);
  expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(originalState);
  expect(await readdir(dir)).toEqual(["launch-state.json"]);
  // A failed transaction must not wedge subsequent saves.
  expect(await setChangelogAutoDisplay(true)).toBe(true);
});

it("keeps the old complete state visible until atomic replacement", async () => {
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    expect(await isChangelogAutoDisplayEnabled()).toBe(false);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(originalState);
    expect(JSON.parse(await readFile(from, "utf8"))).toEqual({ ...originalState, autoShowChangelog: true });
    await actualFs.rename(from, to);
  });
  expect(await setChangelogAutoDisplay(true)).toBe(true);
  expect(await isChangelogAutoDisplayEnabled()).toBe(true);
  expect(await readdir(dir)).toEqual(["launch-state.json"]);
});

it("does not delete invalid state from an unlocked preference read", async () => {
  await writeFile(statePath, JSON.stringify({ invalid: true }));
  expect(await isChangelogAutoDisplayEnabled()).toBe(true);
  expect(await readFile(statePath, "utf8")).toBe(JSON.stringify({ invalid: true }));
});

it("releases its own lock when writing the lock holder fails", async () => {
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actualFs.open(...args);
    vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("lock write failed"));
    return handle;
  });
  expect(await setChangelogAutoDisplay(true)).toBe(false);
  expect(await readdir(dir)).toEqual(["launch-state.json"]);
  expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(originalState);
  expect(await setChangelogAutoDisplay(true)).toBe(true);
});
