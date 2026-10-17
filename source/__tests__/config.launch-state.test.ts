import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const home = await mkdtemp(join(tmpdir(), "agav-launch-state-"));
const agavDir = join(home, ".agav");
const statePath = join(agavDir, "launch-state.json");
await mkdir(agavDir, { recursive: true });

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: actual, homedir: () => home };
});

const { consumeChangelogDisplay } = await import("../config/launch-state.js");

async function readState(): Promise<{ lastLaunchedVersion: string } | null> {
  try {
    return JSON.parse(await readFile(statePath, "utf-8"));
  } catch {
    return null;
  }
}

beforeEach(async () => {
  await rm(statePath, { force: true });
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe("consumeChangelogDisplay", () => {
  it("does not show a changelog on a fresh installation, but records a baseline", async () => {
    expect(await consumeChangelogDisplay("0.3.0")).toBe(false);
    expect(await readState()).toEqual({ lastLaunchedVersion: "0.3.0" });
  });

  it("does not show a changelog on subsequent launches of the same version", async () => {
    await consumeChangelogDisplay("0.3.0"); // baseline
    expect(await consumeChangelogDisplay("0.3.0")).toBe(false);
    expect(await consumeChangelogDisplay("0.3.0")).toBe(false);
  });

  it("shows the changelog once after an update, then stays quiet", async () => {
    await consumeChangelogDisplay("0.3.0"); // existing install baseline
    // First interactive launch of the new version shows it.
    expect(await consumeChangelogDisplay("0.3.1")).toBe(true);
    expect(await readState()).toEqual({ lastLaunchedVersion: "0.3.1" });
    // Later launches of the same version do not show it again (restart-safe).
    expect(await consumeChangelogDisplay("0.3.1")).toBe(false);
    expect(await consumeChangelogDisplay("0.3.1")).toBe(false);
  });

  it("shows the changelog again on the next update", async () => {
    await consumeChangelogDisplay("0.3.0");
    expect(await consumeChangelogDisplay("0.3.1")).toBe(true);
    expect(await consumeChangelogDisplay("0.3.1")).toBe(false);
    expect(await consumeChangelogDisplay("0.3.2")).toBe(true);
    expect(await consumeChangelogDisplay("0.3.2")).toBe(false);
  });

  it("detects updates regardless of the update mechanism (version change only)", async () => {
    await consumeChangelogDisplay("0.3.1");
    // A beta -> stable or any differing version counts as an update.
    expect(await consumeChangelogDisplay("0.3.1-beta.2")).toBe(true);
  });

  it("treats a corrupt state file as a fresh baseline without showing a changelog", async () => {
    await writeFile(statePath, "{not json");
    expect(await consumeChangelogDisplay("0.3.0")).toBe(false);
    // The corrupt file is replaced with a valid baseline.
    expect(await readState()).toEqual({ lastLaunchedVersion: "0.3.0" });
  });

  it("treats a state file missing the version field as a fresh baseline", async () => {
    await writeFile(statePath, JSON.stringify({ somethingElse: true }));
    expect(await consumeChangelogDisplay("0.3.0")).toBe(false);
    expect(await readState()).toEqual({ lastLaunchedVersion: "0.3.0" });
  });

  it("never throws, returning false when state cannot be persisted", async () => {
    // Make the ~/.agav path a file so ensureDir/writeFile fail.
    await rm(agavDir, { recursive: true, force: true });
    await writeFile(agavDir, "blocker");
    await expect(consumeChangelogDisplay("0.3.0")).resolves.toBe(false);
    // Restore the directory for any later tests.
    await rm(agavDir, { force: true });
    await mkdir(agavDir, { recursive: true });
  });
});
