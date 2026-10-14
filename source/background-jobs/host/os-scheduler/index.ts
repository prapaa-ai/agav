import { homedir as osHomedir } from "node:os";

import type { ResolveTargetDeps, SchedulerContext, SchedulerTarget } from "./common.js";
import {
  classifyTickArgs,
  defaultExecFile,
  defaultFs,
  resolveSchedulerTarget,
  targetExists,
} from "./common.js";
import { installLinux, statusLinux, uninstallLinux } from "./linux.js";
import { installMacos, statusMacos, uninstallMacos } from "./macos.js";
import { installWindows, statusWindows, uninstallWindows } from "./windows.js";

export * from "./common.js";
export * as linux from "./linux.js";
export * as macos from "./macos.js";
export * as windows from "./windows.js";

export type SchedulerBackend = "systemd" | "cron" | "launchd" | "schtasks";

export interface OsSchedulerDeps extends Partial<SchedulerContext> {
  /** Override the resolved target outright (tests). */
  target?: SchedulerTarget;
  resolve?: ResolveTargetDeps;
}

export interface InstallResult {
  backend: SchedulerBackend;
  target: SchedulerTarget;
  files: string[];
}

export interface StatusResult {
  installed: boolean;
  backend?: SchedulerBackend;
  target?: SchedulerTarget;
  /** Unit path, plist path, task name, or "crontab". */
  location?: string;
  targetExists?: boolean;
  /** `--install` should be re-run: the entry's target is gone and differs from the current executable, or it is legacy. */
  stale?: boolean;
  /** Entry uses the legacy `job tick` form. */
  outdated?: boolean;
  current?: SchedulerTarget;
}

export function createSchedulerContext(deps: Partial<SchedulerContext> = {}): SchedulerContext {
  return {
    platform: deps.platform ?? process.platform,
    homedir: deps.homedir ?? osHomedir(),
    uid: deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    execFile: deps.execFile ?? defaultExecFile,
    fs: deps.fs ?? defaultFs,
  };
}

function unsupported(platform: string): Error {
  return new Error(`background scheduler entries are not supported on ${platform}`);
}

async function currentTarget(ctx: SchedulerContext, deps: OsSchedulerDeps): Promise<SchedulerTarget> {
  return deps.target ?? resolveSchedulerTarget({ platform: ctx.platform, ...deps.resolve });
}

export async function installScheduler(deps: OsSchedulerDeps = {}): Promise<InstallResult> {
  const ctx = createSchedulerContext(deps);
  const target = await currentTarget(ctx, deps);
  switch (ctx.platform) {
    case "linux": {
      const r = await installLinux(ctx, target);
      return { backend: r.backend, target, files: r.files };
    }
    case "darwin":
      return { backend: "launchd", target, ...(await installMacos(ctx, target)) };
    case "win32":
      return { backend: "schtasks", target, ...(await installWindows(ctx, target)) };
    default:
      throw unsupported(ctx.platform);
  }
}

export async function uninstallScheduler(deps: OsSchedulerDeps = {}): Promise<{ removed: boolean }> {
  const ctx = createSchedulerContext(deps);
  switch (ctx.platform) {
    case "linux":
      return uninstallLinux(ctx);
    case "darwin":
      return uninstallMacos(ctx);
    case "win32":
      return uninstallWindows(ctx);
    default:
      throw unsupported(ctx.platform);
  }
}

function sameTarget(a: SchedulerTarget, b: SchedulerTarget): boolean {
  return a.executable === b.executable && a.args.length === b.args.length && a.args.every((x, i) => x === b.args[i]);
}

export async function getSchedulerStatus(deps: OsSchedulerDeps = {}): Promise<StatusResult> {
  const ctx = createSchedulerContext(deps);
  let raw: { installed: boolean; backend?: SchedulerBackend; target?: SchedulerTarget; detail?: string };
  switch (ctx.platform) {
    case "linux":
      raw = await statusLinux(ctx);
      break;
    case "darwin":
      raw = { ...(await statusMacos(ctx)), backend: "launchd" };
      break;
    case "win32":
      raw = { ...(await statusWindows(ctx)), backend: "schtasks" };
      break;
    default:
      throw unsupported(ctx.platform);
  }
  if (!raw.installed) return { installed: false };
  const current = await currentTarget(ctx, deps).catch(() => undefined);
  const exists = raw.target ? await targetExists(ctx.fs, raw.target) : false;
  const differs = !raw.target || !current || !sameTarget(raw.target, current);
  const outdated = raw.target ? classifyTickArgs(raw.target.args)?.form === "legacy" : false;
  return {
    installed: true,
    backend: raw.backend,
    ...(raw.target ? { target: raw.target } : {}),
    ...(raw.detail ? { location: raw.detail } : {}),
    targetExists: exists,
    stale: (differs && !exists) || outdated,
    outdated,
    ...(current ? { current } : {}),
  };
}

export function formatTarget(target: SchedulerTarget): string {
  return [target.executable, ...target.args].map((a) => (/[\s"']/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
}
