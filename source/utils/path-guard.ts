import { resolve, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";

/**
 * Paths that are always denied for read or write operations — credential
 * stores, cloud configs, and GPG keyrings.
 */
const DENIED_PATHS = [
  () => resolve(homedir(), ".ssh"),
  () => resolve(homedir(), ".aws"),
  () => resolve(homedir(), ".gnupg"),
  () => resolve(homedir(), ".kube", "config"),
];

/**
 * Return an error string if `filePath` escapes the working directory or
 * reaches into a denied credential path. Returns `null` when the path is
 * allowed.
 *
 * Writable paths: CWD (and children), TMPDIR, and the Agav data directory.
 * Denied paths: ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube/config.
 */
export function checkPathBoundary(
  filePath: string,
  mode: "read" | "write",
): string | null {
  const abs = resolve(filePath);

  // Always deny credential stores regardless of mode
  for (const denied of DENIED_PATHS) {
    const dp = denied();
    if (abs === dp || abs.startsWith(dp + sep)) {
      return `Access denied: ${abs} is inside a protected credential path (${dp}).`;
    }
  }

  if (mode === "write") {
    const cwd = process.cwd();
    const tmp = tmpdir();
    const agavDir = resolve(homedir(), ".agav");

    // Protect repository metadata and Agav config from writes
    const protectedDirs = [
      resolve(cwd, ".git"),
      resolve(cwd, ".agav"),
    ];
    for (const pd of protectedDirs) {
      if (abs === pd || abs.startsWith(pd + sep)) {
        return `Write denied: ${abs} is inside a protected directory (${pd}). Repository metadata and Agav configuration cannot be modified by tools.`;
      }
    }

    const inCwd = abs === cwd || abs.startsWith(cwd + sep);
    const inTmp = abs === tmp || abs.startsWith(tmp + sep);
    const inAgav = abs === agavDir || abs.startsWith(agavDir + sep);

    if (!inCwd && !inTmp && !inAgav) {
      return `Write denied: ${abs} is outside the working directory (${cwd}). File writes are restricted to the project directory, temp directory, and ~/.agav/.`;
    }
  }

  return null;
}
