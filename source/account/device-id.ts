import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Stable per-install DEVICE IDENTITY for browser sign-in.
 *
 * The account service rotates browser sign-in keys per device and caps the number
 * of devices per account. To make that work, the CLI sends a stable, opaque id
 * that identifies THIS installation across logins, plus a friendly label for the
 * dashboard. The id is:
 *   - NOT a secret (it's a correlation id; the server only ever stores its hash),
 *   - generated once and reused, so re-login from the same machine rotates that
 *     machine's key instead of creating a new one,
 *   - random/opaque, so it never leaks the hostname or other machine details.
 *
 * It lives in a plain file next to the (separately, securely stored) account
 * metadata. A read/write failure is non-fatal: we fall back to an ephemeral id so
 * login still works — it just won't correlate with previous logins on this box.
 */

// Resolved lazily (not at import time) so the home directory is read when a
// function actually runs — keeps tests hermetic and respects a changed HOME.
function deviceDir(): string {
  return join(homedir(), ".agav", "account");
}
function devicePath(): string {
  return join(deviceDir(), "device.json");
}

/** Opaque id shape the server accepts (see validDeviceId on the service). */
function newDeviceId(): string {
  return randomBytes(24).toString("base64url"); // 32 url-safe chars
}

/** A human-friendly, non-identifying label for the dashboard (the hostname). */
export function deviceLabel(): string {
  try {
    const name = hostname().trim();
    return name.length > 0 ? name.slice(0, 64) : "Unknown device";
  } catch {
    return "Unknown device";
  }
}

interface DeviceRecord {
  deviceId: string;
}

/**
 * Return this install's stable device id, creating and persisting one on first
 * use. Never throws: on any I/O failure it returns a fresh ephemeral id so sign-in
 * still proceeds (without cross-login correlation).
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const path = devicePath();
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as Partial<DeviceRecord>;
    if (parsed && typeof parsed.deviceId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(parsed.deviceId)) {
      return parsed.deviceId;
    }
  } catch {
    // Missing/unreadable/corrupt → fall through to create a new one.
  }

  const deviceId = newDeviceId();
  try {
    await mkdir(deviceDir(), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify({ deviceId } satisfies DeviceRecord), { mode: 0o600 });
    await rename(temporary, path).catch(async (error) => {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    });
  } catch {
    // Persisting failed; still return the id so login works this session.
  }
  return deviceId;
}

/** The device identity to send with a browser sign-in request. Never throws. */
export async function deviceIdentity(): Promise<{ deviceId: string; deviceLabel: string }> {
  return { deviceId: await getOrCreateDeviceId(), deviceLabel: deviceLabel() };
}

export { devicePath as DEVICE_PATH_FN };
