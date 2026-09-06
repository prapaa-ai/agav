import { resolve, dirname, basename, sep, relative } from "node:path";
import { realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";

/** Whether `candidate` resolves to a path at or under `root` (no symlink resolution — callers needing that should resolve first). */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

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
 * Resolve the true filesystem path, following symlinks. For paths that don't
 * exist yet (new file creation), resolve the parent directory and append the
 * filename — this catches symlinked parent directories. If even the parent
 * doesn't exist, fall back to lexical resolution (the path is genuinely new
 * and cannot be a symlink yet).
 */
async function resolveReal(filePath: string): Promise<string> {
  const abs = resolve(filePath);
  try {
    return await realpath(abs);
  } catch {
    // File doesn't exist — resolve the nearest existing ancestor via realpath
    // and append the remaining relative tail. This catches symlinked ancestor
    // directories even when intermediate children don't exist yet.
    const dir = dirname(abs);
    if (dir === abs) {
      // Reached filesystem root — nothing more to resolve
      return abs;
    }
    const realDir = await resolveReal(dir);
    return resolve(realDir, basename(abs));
  }
}

/**
 * Return an error string if `filePath` escapes the working directory or
 * reaches into a denied credential path. Returns `null` when the path is
 * allowed.
 *
 * Resolves symlinks before checking so that a symlink inside CWD pointing
 * outside cannot bypass the boundary.
 *
 * Writable paths: CWD (and children), TMPDIR, and the Agav data directory.
 * Denied paths: ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube/config.
 */
export async function checkPathBoundary(
  filePath: string,
  mode: "read" | "write",
): Promise<string | null> {
  const abs = await resolveReal(filePath);

  // Always deny credential stores regardless of mode
  for (const denied of DENIED_PATHS) {
    const dp = await resolveReal(denied());
    if (abs === dp || abs.startsWith(dp + sep)) {
      return `Access denied: ${abs} is inside a protected credential path (${dp}).`;
    }
  }

  if (mode === "write") {
    const cwd = await resolveReal(process.cwd());
    const tmp = await resolveReal(tmpdir());
    const agavDir = await resolveReal(resolve(homedir(), ".agav"));

    // Protect repository metadata and Agav config from writes
    const protectedDirs = [
      await resolveReal(resolve(process.cwd(), ".git")),
      await resolveReal(resolve(process.cwd(), ".agav")),
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
