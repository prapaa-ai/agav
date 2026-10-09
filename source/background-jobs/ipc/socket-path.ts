/**
 * OS-appropriate IPC endpoint path selection (T06).
 *
 * - win32: Node's `net` module transparently treats paths of the form
 *   `\\.\pipe\<name>` as named pipes for both `net.createServer().listen()`
 *   and `net.connect()` — same API surface as Unix domain sockets, which is
 *   why a single IpcServer/IpcClient implementation works on both platforms
 *   without branching on transport type. Named pipes are not backed by a
 *   filesystem path, so there is no 104-byte path limit and no stale-file
 *   cleanup concern on this branch.
 * - linux/darwin: a real filesystem path ending in `.sock` inside `root`.
 *   Unix domain socket paths are limited to roughly 104-108 bytes on common
 *   platforms (`sockaddr_un.sun_path`), well short of normal filesystem path
 *   limits. Because `root` is often a long, descriptive application-data
 *   directory, naively joining `root` + `name` can silently exceed that
 *   limit and fail at `listen()` time with a confusing ENAMETOOLONG. To
 *   avoid that, if the computed path would be longer than `SAFE_PATH_LIMIT`
 *   characters, we instead hash `root + name` into a short, fixed-length
 *   filename and place it directly under `root`. This keeps the path stable
 *   (same inputs -> same path) and short regardless of how deep/long `root`
 *   is, at the cost of the filename no longer being human-readable in that
 *   fallback case (callers needing a human-readable name should keep `name`
 *   short and `root` shallow so the fallback is rarely hit).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { platform as osPlatform } from "node:os";

/** Conservative safety margin below common sun_path limits (Linux 108, macOS 104). */
const SAFE_PATH_LIMIT = 100;

export function getSocketPath(root: string, name: string): string {
  if (osPlatform() === "win32") {
    return `\\\\.\\pipe\\agav-${name}`;
  }

  const direct = join(root, `${name}.sock`);
  if (direct.length <= SAFE_PATH_LIMIT) {
    return direct;
  }

  // Fallback: short, deterministic hashed filename to stay under the
  // sockaddr_un length limit while remaining reproducible for the same
  // (root, name) pair.
  const hash = createHash("sha256").update(`${root}\u0000${name}`).digest("hex").slice(0, 16);
  return join(root, `ajb-${hash}.sock`);
}
