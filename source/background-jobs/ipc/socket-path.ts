import { createHash } from "node:crypto";
import { join } from "node:path";
import { platform as osPlatform } from "node:os";

/** Below common sun_path limits (Linux 108, macOS 104). */
const SAFE_PATH_LIMIT = 100;

export function getSocketPath(root: string, name: string): string {
  if (osPlatform() === "win32") {
    return `\\\\.\\pipe\\agav-${name}`;
  }

  const direct = join(root, `${name}.sock`);
  if (Buffer.byteLength(direct) <= SAFE_PATH_LIMIT) {
    return direct;
  }

  // Over the sun_path limit (listen() would fail with ENAMETOOLONG): use a short deterministic hashed name.
  const hash = createHash("sha256").update(`${root}\u0000${name}`).digest("hex").slice(0, 16);
  const fallback = join(root, hash);
  if (Buffer.byteLength(fallback) > SAFE_PATH_LIMIT) {
    throw new Error("Background-jobs storage path is too long for a Unix socket; use a shorter storage root.");
  }
  return fallback;
}
