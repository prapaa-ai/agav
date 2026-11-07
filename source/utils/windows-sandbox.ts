/**
 * Windows restricted-token sandbox backend (opt-in).
 *
 * Agav launches commands through the bundled native helper (native/sandbox-win),
 * which runs them under a WRITE_RESTRICTED token inside a kill-on-close Job
 * Object. Writes succeed only where Agav granted its sandbox SID access: the
 * workspace and a dedicated sandbox temp directory. Protected workspace
 * configuration (Git hooks/config, .agav, editor autoruns, shell startup files)
 * is denied. Reads are not confined, and network access is NOT confined, so
 * Agav refuses sandboxNetwork=deny on this backend rather than pretend.
 *
 * The grants are ACEs added to the user's own files. They are recorded in a
 * journal and can be removed with `agav --revoke-windows-sandbox`.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, win32 } from "node:path";
import { gunzipSync } from "node:zlib";
import { BUNDLED_WINDOWS_SANDBOX_HELPER, type BundledWindowsSandboxHelper } from "./windows-sandbox-bundle.js";
import { discoverSandboxProtectedPaths, resolveSandboxPath } from "./sandbox-protected-paths.js";
import { isWithinRoot } from "./path-guard.js";

export const WINDOWS_SANDBOX_PROTOCOL = "agav-sandbox 1";
export const WINDOWS_SANDBOX_HELPER_ENV = "AGAV_WINDOWS_SANDBOX_HELPER";
const MAX_HELPER_BYTES = 32 * 1024 * 1024;

export const WINDOWS_SANDBOX_NETWORK_DENY_MESSAGE =
  "The Windows sandbox confines file writes but cannot enforce sandboxNetwork=deny. " +
  "The command was not run. Set sandboxNetwork to \"allow\" to use the Windows sandbox, " +
  "or use the Docker override (network disabled).";
export const WINDOWS_SANDBOX_UNAVAILABLE_MESSAGE =
  "The Windows sandbox helper is not available in this build. " +
  `Use a Windows release build, or set ${WINDOWS_SANDBOX_HELPER_ENV} to a built agav-sandbox.exe.`;

let enabled = false;

// Resolved lazily (and without importing config.ts) so loading the sandbox
// module has no filesystem or home-directory side effects. Matches getAgavDir().
function getAgavDir(): string {
  return join(homedir(), ".agav");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
}

/** Opt-in default selection, set at startup from the global `windowsSandbox` config. */
export function setWindowsSandboxEnabled(value: boolean): void {
  enabled = value === true;
}

export function isWindowsSandboxEnabled(): boolean {
  return enabled;
}

function explicitHelperPath(): string | undefined {
  const value = process.env[WINDOWS_SANDBOX_HELPER_ENV];
  return value === undefined ? undefined : expandHome(value);
}

/** True when a helper can be used; never spawns a process (safe during detection). */
export function isWindowsSandboxHelperAvailable(): boolean {
  const explicit = explicitHelperPath();
  if (explicit !== undefined) {
    try { return statSync(explicit).isFile(); } catch { return false; }
  }
  return BUNDLED_WINDOWS_SANDBOX_HELPER !== null;
}

function validBundle(value: BundledWindowsSandboxHelper): boolean {
  return value.protocol === WINDOWS_SANDBOX_PROTOCOL && Number.isSafeInteger(value.size) &&
    value.size > 0 && value.size <= MAX_HELPER_BYTES && /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.gzipBase64 === "string" && value.gzipBase64.length > 0;
}

function cachedHelperMatches(path: string, bundle: BundledWindowsSandboxHelper): boolean {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink in Windows sandbox helper cache: ${path}`);
  if (!info.isFile() || info.size !== bundle.size) return false;
  return createHash("sha256").update(readFileSync(path)).digest("hex") === bundle.sha256;
}

function materializeBundledHelper(bundle: BundledWindowsSandboxHelper): string {
  if (!validBundle(bundle)) throw new Error("Invalid bundled Windows sandbox helper metadata.");
  // The cache lives under the Agav directory, which sandboxed commands cannot write.
  const path = join(getAgavDir(), "sandbox", "windows", bundle.sha256.slice(0, 16), "agav-sandbox.exe");
  if (cachedHelperMatches(path, bundle)) return path;
  const bytes = gunzipSync(Buffer.from(bundle.gzipBase64, "base64"), { maxOutputLength: MAX_HELPER_BYTES });
  if (bytes.length !== bundle.size || createHash("sha256").update(bytes).digest("hex") !== bundle.sha256) {
    throw new Error("Bundled Windows sandbox helper failed integrity verification.");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(staging, bytes, { flag: "wx", mode: 0o700 });
  try { renameSync(staging, path); }
  catch (error) {
    try { unlinkSync(staging); } catch {}
    // A concurrent Agav may have published identical bytes (or holds the exe open).
    if (!cachedHelperMatches(path, bundle)) throw error;
  }
  if (!cachedHelperMatches(path, bundle)) throw new Error("Installed Windows sandbox helper failed integrity verification.");
  return path;
}

/** Resolve the helper executable, installing the bundled copy on first use. */
export function ensureWindowsSandboxHelper(): string {
  const explicit = explicitHelperPath();
  if (explicit !== undefined) {
    let isFile = false;
    try { isFile = statSync(explicit).isFile(); } catch {}
    if (!isFile || extname(explicit).toLowerCase() !== ".exe") {
      throw new Error(`Invalid ${WINDOWS_SANDBOX_HELPER_ENV}: ${explicit || "(empty path)"}. Set it to an existing agav-sandbox.exe.`);
    }
    return explicit;
  }
  if (BUNDLED_WINDOWS_SANDBOX_HELPER === null) throw new Error(WINDOWS_SANDBOX_UNAVAILABLE_MESSAGE);
  return materializeBundledHelper(BUNDLED_WINDOWS_SANDBOX_HELPER);
}

export interface WindowsSandboxInvocation {
  /** Absolute application path, or "" to let CreateProcess search for argv[0]. */
  app: string;
  cmdline: string;
}

export interface WindowsSandboxPolicy extends WindowsSandboxInvocation {
  cwd: string;
  grants: string[];
  denyFiles: string[];
  denyDirs: string[];
  denyDeletes: string[];
}

/** Quote one argument using the rules CommandLineToArgvW / the MSVC CRT parse. */
export function quoteWindowsArgument(arg: string): string {
  if (arg.includes("\0")) throw new Error("Command arguments must not contain NUL characters.");
  if (arg !== "" && !/[ \t\n\v"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") { backslashes++; continue; }
    if (char === '"') quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    else quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

export function windowsArgvInvocation(argv: string[]): WindowsSandboxInvocation {
  if (argv.length === 0) throw new Error("A command is required.");
  return { app: "", cmdline: argv.map(quoteWindowsArgument).join(" ") };
}

/**
 * Same cmd.exe invocation as the unsandboxed Windows runner: cmd parses the
 * quoted tail itself and /s strips only the outer quote pair. cmd.exe is
 * resolved from SystemRoot so a cmd.exe planted in the workspace is not used.
 */
export function windowsShellInvocation(command: string, systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"): WindowsSandboxInvocation {
  if (command.includes("\0")) throw new Error("Commands must not contain NUL characters.");
  return { app: win32.join(systemRoot, "System32", "cmd.exe"), cmdline: `cmd.exe /d /s /c "${command}"` };
}

/** Serialize a policy as "<key> <hex(UTF-8)>" lines; hex avoids all escaping ambiguity. */
export function encodeWindowsSandboxPolicy(policy: WindowsSandboxPolicy): string {
  const lines: string[] = [];
  const add = (key: string, value: string) => {
    if (value.includes("\0")) throw new Error(`Windows sandbox policy ${key} must not contain NUL characters.`);
    lines.push(`${key} ${Buffer.from(value, "utf8").toString("hex")}`);
  };
  if (!policy.cwd || !policy.cmdline || policy.grants.length === 0) {
    throw new Error("Windows sandbox policy requires cwd, cmdline and at least one writable root.");
  }
  add("cwd", policy.cwd);
  add("app", policy.app);
  add("cmdline", policy.cmdline);
  for (const path of policy.grants) add("grant", path);
  for (const path of policy.denyDeletes) add("deny-delete", path);
  for (const path of policy.denyFiles) add("deny-file", path);
  for (const path of policy.denyDirs) add("deny-dir", path);
  return lines.join("\n") + "\n";
}

export function isWindowsDriveRoot(path: string): boolean {
  // A bare drive designator ("D:") is drive-relative to win32.resolve; treat it as the root.
  if (/^[A-Za-z]:[\\/]*$/.test(path)) return true;
  const resolved = win32.resolve(path);
  return win32.dirname(resolved) === resolved;
}

/** Dedicated writable temp directory; TEMP/TMP point here inside the sandbox. */
export function windowsSandboxTempDir(): string {
  const path = join(tmpdir(), "agav-sandbox");
  mkdirSync(path, { recursive: true });
  return resolveSandboxPath(path).path;
}

/**
 * Build the helper policy for one command. Only protected paths inside the
 * workspace get ACEs: outside it the sandbox SID has no write grant anyway, and
 * Agav must not alter permissions elsewhere on the machine.
 */
export function buildWindowsSandboxPolicy(cwd: string, invocation: WindowsSandboxInvocation, temp = windowsSandboxTempDir()): WindowsSandboxPolicy {
  const root = resolveSandboxPath(cwd).path;
  if (isWindowsDriveRoot(root)) {
    throw new Error(`Refusing to sandbox a drive root as the workspace (${root}); run Agav from a project directory.`);
  }
  const discovered = discoverSandboxProtectedPaths(root);
  const inside = (path: string) => isWithinRoot(root, path);
  const unique = (paths: string[]) => [...new Map(paths.map(path => [path.toLowerCase(), path])).values()];
  const protectedInside = discovered.protectedPaths.filter(({ path }) => inside(path));
  return {
    cwd: root,
    ...invocation,
    grants: unique([root, temp]),
    denyFiles: unique(protectedInside.filter(({ kind }) => kind === "file").map(({ path }) => path)),
    denyDirs: unique(protectedInside.filter(({ kind }) => kind === "directory").map(({ path }) => path)),
    denyDeletes: unique(protectedInside.filter(({ kind }) => kind === "ancestor").map(({ path }) => path)),
  };
}

function setEnv(env: Record<string, string>, key: string, value: string): void {
  // Windows environment names are case-insensitive; drop any case variant first.
  for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
  env[key] = value;
}

/** Redirect temp and common package caches into the writable sandbox temp directory. */
export function windowsSandboxEnv(base: Record<string, string>, temp: string): Record<string, string> {
  const env = { ...base };
  setEnv(env, "TEMP", temp);
  setEnv(env, "TMP", temp);
  setEnv(env, "npm_config_cache", join(temp, "npm-cache"));
  setEnv(env, "PIP_CACHE_DIR", join(temp, "pip-cache"));
  setEnv(env, "YARN_CACHE_FOLDER", join(temp, "yarn-cache"));
  return env;
}

function journalPath(): string {
  return join(getAgavDir(), "sandbox", "windows-grants.json");
}

function readJournal(): string[] {
  let text: string;
  try { text = readFileSync(journalPath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
    throw new Error(`Invalid Windows sandbox grant journal: ${journalPath()}`);
  }
  return parsed;
}

function writeJournal(paths: string[]): void {
  const path = journalPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(staging, JSON.stringify(paths, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(staging, path);
}

/** Record writable roots before the helper grants them, so they can always be revoked. */
export function recordWindowsSandboxGrants(paths: string[]): void {
  const journal = readJournal();
  const known = new Set(journal.map(path => path.toLowerCase()));
  const added = paths.filter(path => !known.has(path.toLowerCase()));
  if (added.length > 0) writeJournal([...journal, ...added]);
}

export function listWindowsSandboxGrants(): string[] {
  return readJournal();
}

/** Remove Agav's sandbox ACEs from every journaled root. */
export function revokeWindowsSandboxGrants(): { revoked: string[]; failed: Array<{ path: string; error: string }> } {
  const journal = readJournal();
  if (journal.length === 0) return { revoked: [], failed: [] };
  const helper = ensureWindowsSandboxHelper();
  const revoked: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const path of journal) {
    if (!existsSync(path)) { revoked.push(path); continue; }
    try {
      execFileSync(helper, ["revoke", path], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 30 * 60_000 });
      revoked.push(path);
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
      failed.push({ path, error: stderr || (error instanceof Error ? error.message : String(error)) });
    }
  }
  writeJournal(failed.map(({ path }) => path));
  return { revoked, failed };
}

export interface PreparedWindowsSandboxRun {
  file: string;
  args: string[];
  env: Record<string, string>;
  cleanup: () => void;
}

/** Write the per-command policy file and return the helper invocation. */
export function prepareWindowsSandboxRun(opts: { cwd: string; invocation: WindowsSandboxInvocation; env: Record<string, string> }): PreparedWindowsSandboxRun {
  const helper = ensureWindowsSandboxHelper();
  const temp = windowsSandboxTempDir();
  const policy = buildWindowsSandboxPolicy(opts.cwd, opts.invocation, temp);
  recordWindowsSandboxGrants(policy.grants);
  const policyPath = join(tmpdir(), `agav-windows-sandbox-${process.pid}-${randomUUID()}.policy`);
  writeFileSync(policyPath, encodeWindowsSandboxPolicy(policy), { flag: "wx", mode: 0o600 });
  return {
    file: helper,
    args: ["exec", policyPath],
    env: windowsSandboxEnv(opts.env, temp),
    cleanup: () => { try { unlinkSync(policyPath); } catch {} },
  };
}
