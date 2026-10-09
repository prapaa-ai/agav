/**
 * T07 — minimal environment construction for launched workloads.
 *
 * Per solution.md §8: "Construct a documented minimal environment, including
 * OS essentials for executable discovery, home/temp locations and Windows
 * system paths. Normalize Windows key casing. Filter runtime-injection
 * variables by default and allow additional named inheritance only through
 * explicit policy." and "Report missing/filtered variable names, not
 * values."
 *
 * This module never logs or returns a secret VALUE in any diagnostic field —
 * only variable NAMES ever appear in `missingCredentials` or thrown error
 * messages.
 */

export interface BuildMinimalEnvironmentOptions {
  /** Names of additional process.env vars to inherit verbatim, nothing else. */
  inherit?: string[];
  /**
   * Map of envVarName -> already-resolved credential value. This function
   * does not itself fetch secrets from any vault/store; the caller resolves
   * references elsewhere and hands over the final value here. Only the KEY
   * ever appears in this module's return value or errors.
   */
  credentialRefs?: Record<string, string>;
}

export interface BuildMinimalEnvironmentResult {
  env: Record<string, string>;
  /** Names (never values) of credential refs that resolved to undefined/empty. */
  missingCredentials: string[];
}

/**
 * Build a minimal, documented environment for a launched workload.
 *
 * Always-included OS essentials and why:
 *   - PATH: required so the OS/shell can locate executables by name.
 *   - POSIX HOME: many tools (git, npm, language runtimes) resolve config/
 *     cache locations relative to the user's home directory.
 *   - POSIX TMPDIR: conventional location for scratch files; some tools fail
 *     outright without it.
 *   - win32 USERPROFILE: Windows analogue of HOME, used by many CLI tools.
 *   - win32 TEMP / TMP: Windows conventional scratch-file locations (both
 *     are commonly checked; tools vary on which they read).
 *   - win32 SystemRoot: required by many Windows system DLLs/APIs to locate
 *     C:\Windows; omitting it can break seemingly unrelated subprocesses.
 *   - win32 ComSpec: the canonical path to cmd.exe some tools shell out via;
 *     without it, tools that rely on %ComSpec% to find a shell can fail.
 *
 * Everything else from process.env is filtered out by default ("filter
 * runtime-injection variables by default") and only reaches the result
 * through explicit `opts.inherit` names or `opts.credentialRefs` keys.
 */
export function buildMinimalEnvironment(
  platform: "linux" | "darwin" | "win32",
  opts: BuildMinimalEnvironmentOptions = {},
): BuildMinimalEnvironmentResult {
  const env: Record<string, string> = {};
  const source = process.env;

  if (source.PATH !== undefined) env.PATH = source.PATH;

  if (platform === "win32") {
    if (source.USERPROFILE !== undefined) env.USERPROFILE = source.USERPROFILE;
    if (source.TEMP !== undefined) env.TEMP = source.TEMP;
    if (source.TMP !== undefined) env.TMP = source.TMP;
    if (source.SystemRoot !== undefined) env.SystemRoot = source.SystemRoot;
    if (source.ComSpec !== undefined) env.ComSpec = source.ComSpec;
  } else {
    if (source.HOME !== undefined) env.HOME = source.HOME;
    if (source.TMPDIR !== undefined) env.TMPDIR = source.TMPDIR;
  }

  // Explicit named inheritance only — never fall back to copying all of
  // process.env. A name not present in process.env is silently skipped
  // (not an error): the caller asked to inherit it IF present.
  for (const name of opts.inherit ?? []) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  const missingCredentials: string[] = [];
  for (const [name, value] of Object.entries(opts.credentialRefs ?? {})) {
    if (value === undefined || value === "") {
      missingCredentials.push(name);
      continue;
    }
    env[name] = value;
  }

  return { env, missingCredentials };
}

/**
 * Windows environment variable names are case-insensitive at the OS level,
 * but a plain JS Record<string,string> is not. Left unnormalized, two
 * differently-cased keys (e.g. "Path" and "PATH") could both survive into
 * the same object and produce nondeterministic behavior depending on
 * insertion/iteration order and on which child-process API is used to apply
 * the environment.
 *
 * We normalize by uppercasing every key. Uppercase is chosen (rather than
 * lowercase or preserving first-seen casing) because it matches the
 * conventional casing of the Windows-specific variables this module itself
 * introduces (PATH, TEMP, TMP, SystemRoot -> SYSTEMROOT, ComSpec -> COMSPEC),
 * giving one deterministic, documented convention.
 *
 * When two input keys collapse to the same uppercased name, the later
 * Object.entries() iteration order wins (i.e. "last write wins"), which is
 * deterministic for a given input object's key order.
 */
export function normalizeWindowsEnvKeyCasing(env: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    normalized[key.toUpperCase()] = value;
  }
  return normalized;
}
