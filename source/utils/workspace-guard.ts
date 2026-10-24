import { posix, win32 } from "node:path";
import { lstat as fsLstat, readlink as fsReadlink, realpath as fsRealpath } from "node:fs/promises";

type PlatformPath = typeof posix;

/**
 * Workspace containment check used to *warn* (never deny) when a file tool
 * targets a path outside the project root. Denial stays the job of
 * `checkPathBoundary` in path-guard.ts.
 *
 * Resolution: lexically resolve the target against the project root (the same
 * `path.resolve` the file tools use, so `..` collapses identically), realpath
 * the longest existing prefix, then re-append the not-yet-existing tail. The
 * project root goes through the same resolution so symlinked/junctioned/8.3
 * roots compare correctly.
 *
 * Windows specifics (exercised in tests by injecting `path.win32` and a fake
 * realpath):
 * - `\\?\C:\…` / `\\.\C:\…` are unwrapped to `C:\…`; `\\?\UNC\srv\share` to
 *   `\\srv\share`. Any other device-namespace path (`\\.\pipe\…`,
 *   `\\?\Volume{…}`, `\\?\GLOBALROOT…`) is rejected.
 * - UNC targets (`\\server\share\…`) are rejected unless the project root
 *   itself lives on a UNC path.
 * - NTFS alternate data streams (`file.txt:stream`) and reserved device names
 *   (`NUL`, `CON`, `COM1.txt`, …) are rejected.
 * - Junctions and 8.3 short names (`PROGRA~1`) are resolved by realpath of the
 *   existing prefix; comparisons are case-insensitive.
 */

export interface WorkspaceGuardResult {
  /** True when the resolved target is the project root or inside it. */
  inside: boolean;
  /** Best-effort canonical path of the target. */
  resolved: string;
  /** Why the target is not inside (only set when `inside` is false). */
  reason?: string;
}

export interface WorkspaceGuardOptions {
  /** Path implementation; inject `path.win32` to exercise Windows rules. */
  path?: PlatformPath;
  /** realpath implementation; must reject for paths that don't exist. */
  realpath?: (p: string) => Promise<string>;
  /**
   * lstat/readlink implementations used to follow dangling symlinks. Default to
   * node:fs only when `realpath` is not injected (an injected fake realpath
   * describes a virtual fs the real lstat knows nothing about).
   */
  lstat?: (p: string) => Promise<{ isSymbolicLink(): boolean }>;
  readlink?: (p: string) => Promise<string>;
  /** Compare paths case-insensitively. Defaults to true on Windows rules and macOS. */
  caseInsensitive?: boolean;
}

export const OUTSIDE_PROJECT_REASON = "outside project root";

const WIN_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

function isWindowsPath(p: PlatformPath): boolean {
  return p.sep === "\\";
}

function isUnc(p: string): boolean {
  return p.startsWith("\\\\");
}

type Unwrapped = { ok: true; path: string } | { ok: false; path: string; reason: string };

/**
 * Unwrap Win32 device-namespace prefixes (`\\?\`, `\\.\`, `\??\`) on a raw,
 * not-yet-resolved string; reject device paths that don't name a file system
 * location. Must run before `path.win32.resolve`, which would otherwise treat
 * `\\?\C:` as a UNC server/share pair.
 */
function unwrapWindowsDevicePath(input: string): Unwrapped {
  const normalized = input.replace(/\//g, "\\");
  const match = /^(?:\\\\[?.]\\|\\\?\?\\)(.*)$/.exec(normalized);
  if (!match) return { ok: true, path: input };
  const rest = match[1] ?? "";
  if (/^[a-z]:(\\|$)/i.test(rest)) return { ok: true, path: rest.length === 2 ? `${rest}\\` : rest };
  if (/^unc\\[^\\]+\\[^\\]+/i.test(rest)) return { ok: true, path: `\\\\${rest.slice(4)}` };
  return { ok: false, path: input, reason: "device namespace path" };
}

/** Lexical Windows checks that make a target unsafe to compare by prefix. */
function windowsLexicalRejection(abs: string): string | undefined {
  const body = isUnc(abs) ? abs.slice(2) : abs.replace(/^[a-z]:/i, "");
  if (body.includes(":")) return "NTFS alternate data stream";
  for (const segment of body.split("\\")) {
    // Win32 matches device names on the part before the first dot with trailing
    // spaces ignored, so `con.txt` and `COM1 .log` still open the device.
    const stem = (segment.split(".")[0] ?? "").replace(/ +$/, "");
    if (stem && WIN_RESERVED_NAME.test(stem)) return "reserved device name";
  }
  return undefined;
}

/** Max symlink hops followed through dangling links before giving up (matches Linux MAXSYMLINKS). */
const MAX_SYMLINK_HOPS = 40;

export const SYMLINK_LOOP_REASON = "too many symbolic links";

interface LinkOps {
  lstat: (p: string) => Promise<{ isSymbolicLink(): boolean }>;
  readlink: (p: string) => Promise<string>;
}

type PrefixResolution = { ok: true; path: string } | { ok: false; path: string };

/**
 * realpath the longest existing prefix of `abs`, then re-append the missing tail.
 *
 * realpath fails for a dangling symlink (`proj/x -> /etc/new` with `/etc/new`
 * missing), yet a write through it would create the link's target. So when a
 * component can't be realpath'd, lstat it; if it is a symlink, splice its
 * target (relative to the link's real directory) in place of the component and
 * resolve again. Exceeding MAX_SYMLINK_HOPS (e.g. a link loop) is unsafe.
 */
async function resolveLongestExistingPrefix(
  abs: string,
  p: PlatformPath,
  realpath: (p: string) => Promise<string>,
  links?: LinkOps,
): Promise<PrefixResolution> {
  let pending = abs;
  for (let hops = 0; ; hops++) {
    const tail: string[] = [];
    let current = pending;
    let next = pending;
    for (;;) {
      try {
        const real = await realpath(current);
        return { ok: true, path: tail.length > 0 ? p.join(real, ...tail.reverse()) : real };
      } catch {
        const parent = p.dirname(current);
        if (parent === current) return { ok: true, path: pending }; // Nothing exists — lexical result is all we have.
        const linkTarget = links ? await readDanglingLink(current, links) : undefined;
        if (linkTarget !== undefined) {
          let base: string;
          try {
            base = await realpath(parent);
          } catch {
            base = parent;
          }
          const target = p.resolve(base, linkTarget);
          next = tail.length > 0 ? p.join(target, ...tail.reverse()) : target;
          break;
        }
        tail.push(p.basename(current));
        current = parent;
      }
    }
    if (hops >= MAX_SYMLINK_HOPS) return { ok: false, path: next };
    pending = next;
  }
}

/** Link text of `candidate` if it is a symlink (lstat succeeds), else undefined. */
async function readDanglingLink(candidate: string, links: LinkOps): Promise<string | undefined> {
  try {
    if (!(await links.lstat(candidate)).isSymbolicLink()) return undefined;
    return await links.readlink(candidate);
  } catch {
    return undefined;
  }
}

function isWithin(root: string, target: string, p: PlatformPath, caseInsensitive: boolean): boolean {
  const r = caseInsensitive ? root.toLowerCase() : root;
  const t = caseInsensitive ? target.toLowerCase() : target;
  const rel = p.relative(r, t);
  return rel === "" || (!p.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${p.sep}`));
}

async function checkContainment(
  target: string,
  projectRoot: string,
  options: WorkspaceGuardOptions,
): Promise<WorkspaceGuardResult> {
  const p: PlatformPath = options.path ?? (process.platform === "win32" ? win32 : posix);
  const baseRealpath: (q: string) => Promise<string> = options.realpath ?? ((q: string) => fsRealpath(q));
  const win = isWindowsPath(p);
  const caseInsensitive = options.caseInsensitive ?? (win || process.platform === "darwin");

  let rawRoot = projectRoot;
  let rawTarget = target;
  if (win) {
    rawRoot = unwrapWindowsDevicePath(projectRoot).path;
    const unwrapped = unwrapWindowsDevicePath(target);
    if (!unwrapped.ok) return { inside: false, resolved: target, reason: unwrapped.reason };
    rawTarget = unwrapped.path;
  }
  const rootAbs = p.resolve(rawRoot);
  const abs = p.resolve(rootAbs, rawTarget);

  // Native Windows realpath can hand back `\\?\` forms; unwrap them so prefixes compare.
  const realpath = win
    ? async (candidate: string) => p.resolve(unwrapWindowsDevicePath(await baseRealpath(candidate)).path)
    : baseRealpath;

  if (win) {
    const rejection = windowsLexicalRejection(abs);
    if (rejection) return { inside: false, resolved: abs, reason: rejection };
    if (isUnc(abs) && !isUnc(rootAbs)) return { inside: false, resolved: abs, reason: "UNC network path" };
  }

  const useNodeLinks = options.realpath === undefined;
  const lstat = options.lstat ?? (useNodeLinks ? (q: string) => fsLstat(q) : undefined);
  const baseReadlink = options.readlink ?? (useNodeLinks ? (q: string) => fsReadlink(q) : undefined);
  // Windows link text can carry `\\?\` prefixes too.
  const readlink = baseReadlink && win
    ? async (q: string) => unwrapWindowsDevicePath(await baseReadlink(q)).path
    : baseReadlink;
  const links: LinkOps | undefined = lstat && readlink ? { lstat, readlink } : undefined;

  const rootResolution = await resolveLongestExistingPrefix(rootAbs, p, realpath, links);
  const targetResolution = await resolveLongestExistingPrefix(abs, p, realpath, links);
  const resolved = targetResolution.path;
  if (!rootResolution.ok || !targetResolution.ok) return { inside: false, resolved, reason: SYMLINK_LOOP_REASON };
  const realRoot = rootResolution.path;
  return isWithin(realRoot, resolved, p, caseInsensitive)
    ? { inside: true, resolved }
    : { inside: false, resolved, reason: OUTSIDE_PROJECT_REASON };
}

/** Check whether a write target resolves inside `projectRoot`. Never throws for missing paths. */
export function checkWrite(
  target: string,
  projectRoot: string,
  options: WorkspaceGuardOptions = {},
): Promise<WorkspaceGuardResult> {
  return checkContainment(target, projectRoot, options);
}

/** Check whether a read target resolves inside `projectRoot`. Informational only; reads are not gated on it. */
export function checkRead(
  target: string,
  projectRoot: string,
  options: WorkspaceGuardOptions = {},
): Promise<WorkspaceGuardResult> {
  return checkContainment(target, projectRoot, options);
}

/** One-line confirmation-prompt warning for an outside target, or undefined when inside. */
export function formatWorkspaceWarning(result: WorkspaceGuardResult): string | undefined {
  if (result.inside) return undefined;
  const detail = result.reason && result.reason !== OUTSIDE_PROJECT_REASON ? ` (${result.reason})` : "";
  return `Target is outside the project: ${result.resolved}${detail}`;
}
