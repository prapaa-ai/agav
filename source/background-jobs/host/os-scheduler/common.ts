import { execFile as nodeExecFile } from "node:child_process";
import { promises as nodeFs, constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { BACKGROUND_TICK_INTERNAL_FLAG, getBackgroundTickArgs, isStandaloneBinary } from "../../packaging/manifest.js";

export interface SchedulerTarget {
  executable: string;
  args: string[];
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (file: string, args: string[]) => Promise<ExecFileResult>;

export interface SchedulerFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options: { recursive: true; mode?: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  access(path: string, mode?: number): Promise<void>;
}

export interface SchedulerContext {
  platform: NodeJS.Platform;
  homedir: string;
  uid: number;
  execFile: ExecFileFn;
  fs: SchedulerFs;
}

/**
 * Legacy tick form (`<exe> [entry] job tick`) loads the full CLI every minute; new entries use the
 * headless `BACKGROUND_TICK_INTERNAL_FLAG`. Still recognised so `--status` can flag old entries.
 */
export const TICK_SUBCOMMAND = ["job", "tick"] as const;
export const STALE_ENTRY_MESSAGE = "Background scheduler entry is stale or outdated — re-run `agav job tick --install`";

export type TickCommandForm = "current" | "legacy";

/** Splits args into leading CLI-entry paths and the tick form; undefined when neither form matches. */
export function classifyTickArgs(args: readonly string[]): { form: TickCommandForm; leading: string[] } | undefined {
  const n = args.length;
  if (n >= 1 && args[n - 1] === BACKGROUND_TICK_INTERNAL_FLAG) return { form: "current", leading: args.slice(0, n - 1) };
  if (n >= 2 && args[n - 2] === TICK_SUBCOMMAND[0] && args[n - 1] === TICK_SUBCOMMAND[1]) {
    return { form: "legacy", leading: args.slice(0, n - 2) };
  }
  return undefined;
}

export const defaultExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

export const defaultFs: SchedulerFs = {
  readFile: (p, enc) => nodeFs.readFile(p, enc),
  writeFile: (p, data, options) => nodeFs.writeFile(p, data, options),
  mkdir: (p, options) => nodeFs.mkdir(p, options),
  rename: (a, b) => nodeFs.rename(a, b),
  unlink: (p) => nodeFs.unlink(p),
  access: (p, mode) => nodeFs.access(p, mode),
};

export function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export async function fileExists(fs: SchedulerFs, p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readIfExists(fs: SchedulerFs, p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeFileAtomic(
  ctx: Pick<SchedulerContext, "fs" | "platform">,
  target: string,
  data: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const p = pathFor(ctx.platform);
  const dir = p.dirname(target);
  await ctx.fs.mkdir(dir, { recursive: true });
  const tmp = p.join(dir, `.${p.basename(target)}.tmp-${randomUUID()}`);
  try {
    await ctx.fs.writeFile(tmp, data, { mode });
    await ctx.fs.rename(tmp, target);
  } catch (error) {
    await ctx.fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

export async function unlinkIfExists(fs: SchedulerFs, p: string): Promise<boolean> {
  try {
    await fs.unlink(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function targetExists(fs: SchedulerFs, target: SchedulerTarget): Promise<boolean> {
  if (!(await fileExists(fs, target.executable))) return false;
  const leading = classifyTickArgs(target.args)?.leading ?? [];
  for (const entry of leading) {
    if (!(await fileExists(fs, entry))) return false;
  }
  return true;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    if (stderr) return stderr;
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

export interface ResolveTargetDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
  entryPath?: string;
  standalone?: boolean;
  which?: (name: string) => Promise<string | undefined>;
  realpath?: (p: string) => Promise<string>;
}

const CELLAR_RE = /[\\/]Cellar[\\/]/;

export function isCellarPath(p: string): boolean {
  return CELLAR_RE.test(p);
}

async function defaultWhich(name: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const p = pathFor(platform);
  const dirs = (process.env["PATH"] ?? "").split(p.delimiter).filter(Boolean);
  const exts = platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      try {
        await nodeFs.access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

/** Under a versioned Homebrew Cellar path, prefers the stable PATH shim if it resolves to our executable. */
export async function resolveSchedulerTarget(deps: ResolveTargetDeps = {}): Promise<SchedulerTarget> {
  const platform = deps.platform ?? process.platform;
  const realpath = deps.realpath ?? ((p: string) => nodeFs.realpath(p));
  const which = deps.which ?? ((name: string) => defaultWhich(name, platform));
  const execPath = deps.execPath ?? process.execPath;
  const standalone = deps.standalone ?? isStandaloneBinary();
  const safeRealpath = async (p: string): Promise<string> => {
    try {
      return await realpath(p);
    } catch {
      return p;
    }
  };

  let executable = execPath;
  if (isCellarPath(execPath)) {
    const name = standalone ? "agav" : pathFor(platform).basename(execPath).replace(/\.exe$/i, "");
    const shim = await which(name).catch(() => undefined);
    if (shim && !isCellarPath(shim) && (await safeRealpath(shim)) === (await safeRealpath(execPath))) {
      executable = shim;
    }
  }

  if (standalone) return { executable, args: getBackgroundTickArgs() };

  const rawEntry = deps.entryPath ?? process.argv[1];
  if (!rawEntry) throw new Error("cannot resolve the agav CLI entry script (process.argv[1] is empty)");
  const entry = await safeRealpath(pathFor(platform).resolve(rawEntry));
  return { executable, args: getBackgroundTickArgs(entry) };
}
