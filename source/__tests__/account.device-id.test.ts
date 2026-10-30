import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point ~/.agav at a throwaway dir so the test never touches the real home.
let home: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home, hostname: () => "Test-Machine" };
});

const { getOrCreateDeviceId, deviceLabel, deviceIdentity, DEVICE_PATH_FN } = await import("../account/device-id.js");
const DEVICE_PATH = () => DEVICE_PATH_FN();

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agav-device-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("device-id", () => {
  it("creates an opaque id on first use and persists it to disk", async () => {
    const id = await getOrCreateDeviceId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    const onDisk = JSON.parse(readFileSync(DEVICE_PATH(), "utf8"));
    expect(onDisk.deviceId).toBe(id);
  });

  it("returns the SAME id across calls (stable per install)", async () => {
    const first = await getOrCreateDeviceId();
    const second = await getOrCreateDeviceId();
    expect(second).toBe(first);
  });

  it("regenerates when the stored id is corrupt", async () => {
    const first = await getOrCreateDeviceId();
    // Corrupt the file, then confirm a fresh valid id is minted + persisted.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(DEVICE_PATH(), "{ not valid json");
    const regenerated = await getOrCreateDeviceId();
    expect(regenerated).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(regenerated).not.toBe(first);
  });

  it("uses the hostname as the (bounded) label", () => {
    expect(deviceLabel()).toBe("Test-Machine");
  });

  it("deviceIdentity bundles a persisted id and a label", async () => {
    const identity = await deviceIdentity();
    expect(identity.deviceId).toBe(await getOrCreateDeviceId());
    expect(identity.deviceLabel).toBe("Test-Machine");
  });
});
