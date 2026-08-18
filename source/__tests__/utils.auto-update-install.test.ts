import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
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
const { installUpdate, cleanupStaleBackups } = await import("../utils/auto-update.js");

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
