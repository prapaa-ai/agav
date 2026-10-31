// Secret VALUES must never appear in diagnostics; only variable NAMES do.

/**
 * Private channel for the values of a spec's `envInherit` names: one JSON-encoded variable in the supervisor's
 * process environment, never persisted. The supervisor removes it from its own environment on startup.
 */
export const INHERITED_ENV_VAR = "AGAV_BG_INHERITED_ENV";

export interface BuildMinimalEnvironmentOptions {
  /** Names of additional process.env vars to inherit verbatim, nothing else. */
  inherit?: string[];
  /** envVarName -> already-resolved credential value (resolved by the caller). */
  credentialRefs?: Record<string, string>;
}

export interface BuildMinimalEnvironmentResult {
  env: Record<string, string>;
  /** Names (never values) of credential refs that resolved to undefined/empty. */
  missingCredentials: string[];
}

/**
 * Only OS essentials (PATH, HOME/TMPDIR or USERPROFILE/TEMP/TMP/SystemRoot/ComSpec) are copied
 * from process.env; anything else needs explicit `opts.inherit` or `opts.credentialRefs`.
 * SystemRoot/ComSpec are needed on Windows or unrelated subprocesses can break.
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

  // Names absent from process.env are silently skipped.
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
 * Windows env names are case-insensitive but JS records are not, so "Path" and "PATH"
 * could both survive. Uppercase every key; on collision the later key wins.
 */
export function normalizeWindowsEnvKeyCasing(env: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    normalized[key.toUpperCase()] = value;
  }
  return normalized;
}
