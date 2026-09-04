import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only `rm` is faked — everything else runs against a real temp directory, so
// the rename/copy behaviour under test is the real thing.
const rmMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, default: actual, rm: rmMock };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { installUpdate, cleanupStaleBackups, pruneOldReleases, isNewer } = await import(
  "../utils/auto-update.js"
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agav-update-"));
  rmMock.mockReset();
  rmMock.mockImplementation((...args: any[]) => (actualFs.rm as any)(...args));
});

afterEach(async () => {
  await actualFs.rm(dir, { recursive: true, force: true });
});

async function seedInstall(): Promise<{ binaryPath: string; downloadPath: string }> {
  const binaryPath = join(dir, "agav.exe");
  const downloadPath = join(dir, "agav-update-v0.1.7");
  await writeFile(binaryPath, "old binary");
  await writeFile(downloadPath, "new binary");
  return { binaryPath, downloadPath };
}

describe("installUpdate on a plain binary install", () => {
  it("puts the downloaded binary in place and clears the backup", async () => {
    const { binaryPath, downloadPath } = await seedInstall();

    await installUpdate(downloadPath, "v0.1.7", binaryPath);

    expect(await readFile(binaryPath, "utf8")).toBe("new binary");
    expect((await readdir(dir)).filter((f) => f.endsWith(".bak"))).toEqual([]);
  });

  // Windows refuses to delete the executable of a running process, so the very
  // last step of an otherwise successful update used to throw and get reported
  // as "failed (replace error)" — while the new binary was already installed.
  it("still succeeds when the backup cannot be deleted", async () => {
    const { binaryPath, downloadPath } = await seedInstall();
    rmMock.mockImplementation(async (target: any) => {
      if (String(target).endsWith(".bak")) {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return (actualFs.rm as any)(target, { force: true });
    });

    await expect(installUpdate(downloadPath, "v0.1.7", binaryPath)).resolves.toBeUndefined();
    expect(await readFile(binaryPath, "utf8")).toBe("new binary");
  });

  // Two agav processes updating in turn must not collide on one backup name:
  // the first one's backup is still locked when the second one renames.
  it("names the backup per process so a locked leftover cannot block it", async () => {
    const { binaryPath, downloadPath } = await seedInstall();
    await writeFile(join(dir, "agav.exe.99999.bak"), "someone else's locked backup");
    rmMock.mockImplementation(async (target: any) => {
      if (String(target).endsWith(".bak")) throw new Error("EPERM");
      return (actualFs.rm as any)(target, { force: true });
    });

    await installUpdate(downloadPath, "v0.1.7", binaryPath);

    const backups = (await readdir(dir)).filter((f) => f.endsWith(".bak")).sort();
    expect(backups).toContain("agav.exe.99999.bak");
    expect(backups).toContain(`agav.exe.${process.pid}.bak`);
  });
});

/** Build the installer's `<root>/standalone/releases/<version>/agav` layout. */
async function seedManagedInstall(versions: string[], running: string) {
  const releases = join(dir, "packages", "standalone", "releases");
  for (const version of versions) {
    await mkdir(join(releases, version), { recursive: true });
    await writeFile(join(releases, version, "agav"), `binary ${version}`);
  }
  const downloadPath = join(dir, "agav-update-v9.9.9");
  await writeFile(downloadPath, "new binary");
  return { releases, binaryPath: join(releases, running, "agav"), downloadPath };
}

describe("installUpdate on a managed install", () => {
  // Every auto-update left its predecessor behind: a ~100 MB release directory
  // per version, forever. install.sh has always pruned; this side never did.
  it("keeps only the release it just installed", async () => {
    const { releases, binaryPath, downloadPath } = await seedManagedInstall(
      ["0.1.5", "0.1.6", "0.1.7"],
      "0.1.7",
    );

    await installUpdate(downloadPath, "v0.1.8", binaryPath);

    expect((await readdir(releases)).sort()).toEqual(["0.1.8"]);
    expect(await readFile(join(releases, "0.1.8", "agav"), "utf8")).toBe("new binary");
  });

  it("points `current` at the new release before pruning the old ones", async () => {
    const { binaryPath, downloadPath } = await seedManagedInstall(["0.1.7"], "0.1.7");

    await installUpdate(downloadPath, "v0.1.8", binaryPath);

    const currentLink = join(dir, "packages", "standalone", "current");
    // Resolving through the symlink proves it was swapped, not left dangling
    // at the directory the prune removed.
    expect(await readFile(join(currentLink, "agav"), "utf8")).toBe("new binary");
  });

  it("still installs when a leftover release directory cannot be removed", async () => {
    const { releases, binaryPath, downloadPath } = await seedManagedInstall(
      ["0.1.6", "0.1.7"],
      "0.1.7",
    );
    rmMock.mockImplementation(async (target: any, opts: any) => {
      if (String(target).endsWith("0.1.6")) throw new Error("EBUSY");
      return (actualFs.rm as any)(target, opts);
    });

    await expect(installUpdate(downloadPath, "v0.1.8", binaryPath)).resolves.toBeUndefined();
    expect(await readFile(join(releases, "0.1.8", "agav"), "utf8")).toBe("new binary");
  });
});

describe("pruneOldReleases", () => {
  it("leaves files and the kept directory alone", async () => {
    const releases = join(dir, "releases");
    await mkdir(join(releases, "0.1.6"), { recursive: true });
    await mkdir(join(releases, "0.1.7"), { recursive: true });
    await writeFile(join(releases, "notes.txt"), "keep me");

    await pruneOldReleases(releases, join(releases, "0.1.7"));

    expect((await readdir(releases)).sort()).toEqual(["0.1.7", "notes.txt"]);
  });

  it("never throws when the releases directory is missing", async () => {
    await expect(pruneOldReleases(join(dir, "nope"), join(dir, "nope", "x"))).resolves.toBeUndefined();
  });
});

describe("isNewer", () => {
  it.each([
    ["v0.1.8", "0.1.7"],
    ["v0.2.0", "0.1.9"],
    ["v1.0.0", "0.9.9"],
    ["v0.1.10", "0.1.9"],
  ])("treats %s as newer than %s", (remote, local) => {
    expect(isNewer(remote, local)).toBe(true);
  });

  it.each([
    ["v0.1.7", "0.1.7"],
    ["v0.1.6", "0.1.7"],
    ["v0.0.9", "0.1.0"],
  ])("treats %s as not newer than %s", (remote, local) => {
    expect(isNewer(remote, local)).toBe(false);
  });

  // Regression: `split(".").map(Number)` turned the suffixed part into NaN, and
  // NaN loses every comparison, so the loop fell through to "not newer". A
  // patch-level pre-release marked latest froze every client on its current
  // version, silently and forever.
  it("compares the core version of a pre-release tag", () => {
    expect(isNewer("v0.1.8-rc1", "0.1.7")).toBe(true);
    expect(isNewer("v0.1.8-beta.3", "0.1.7")).toBe(true);
    expect(isNewer("v0.2.0-rc1", "0.1.7")).toBe(true);
    expect(isNewer("v1.0.0+build.42", "0.9.9")).toBe(true);
  });

  it("does not sidegrade into a pre-release of the version already installed", () => {
    expect(isNewer("v0.1.7-rc1", "0.1.7")).toBe(false);
  });

  // Regression: a stable release (0.2.0) was not offered as an upgrade to
  // users running a pre-release of the same version (0.2.0-beta.3) because
  // parseVersion strips the suffix and the cores compare equal. The fix:
  // stable > pre-release when the core version is the same.
  it("upgrades from a pre-release to the stable release of the same version", () => {
    expect(isNewer("v0.2.0", "0.2.0-beta.3")).toBe(true);
    expect(isNewer("v0.2.0", "0.2.0-rc1")).toBe(true);
    expect(isNewer("v1.0.0", "1.0.0-alpha.1")).toBe(true);
  });

  it("does not sidegrade between pre-releases of the same version", () => {
    expect(isNewer("v0.2.0-beta.4", "0.2.0-beta.3")).toBe(false);
    expect(isNewer("v0.2.0-rc1", "0.2.0-beta.3")).toBe(false);
  });

  it("refuses to act on a tag it cannot parse", () => {
    expect(isNewer("nightly", "0.1.7")).toBe(false);
    expect(isNewer("", "0.1.7")).toBe(false);
    expect(isNewer("v0.1.8", "not-a-version")).toBe(false);
  });
});

describe("cleanupStaleBackups", () => {
  it("removes leftovers from earlier updates and leaves everything else alone", async () => {
    const binaryPath = join(dir, "agav.exe");
    await writeFile(binaryPath, "binary");
    await writeFile(join(dir, "agav.exe.123.bak"), "old");
    await writeFile(join(dir, "agav.exe.456.bak"), "older");
    await writeFile(join(dir, "notes.txt"), "keep me");

    await cleanupStaleBackups(binaryPath);

    expect((await readdir(dir)).sort()).toEqual(["agav.exe", "notes.txt"]);
  });

  it("never throws when a backup is still locked", async () => {
    const binaryPath = join(dir, "agav.exe");
    await writeFile(binaryPath, "binary");
    await writeFile(join(dir, "agav.exe.123.bak"), "locked");
    rmMock.mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));

    await expect(cleanupStaleBackups(binaryPath)).resolves.toBeUndefined();
  });

  it("never throws when the directory does not exist", async () => {
    await expect(cleanupStaleBackups(join(dir, "gone", "agav.exe"))).resolves.toBeUndefined();
  });
});
