import type { SchedulerContext, SchedulerTarget } from "./common.js";
import { readIfExists, unlinkIfExists, writeFileAtomic } from "./common.js";

export const LAUNCHD_LABEL = "dev.agav.job-tick";

export function launchAgentPath(homedir: string): string {
  return `${homedir}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
}

export function launchdLogDir(homedir: string): string {
  return `${homedir}/.agav/logs`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function generateLaunchdPlist(target: SchedulerTarget, homedir: string): string {
  const logDir = launchdLogDir(homedir);
  const programArgs = [target.executable, ...target.args].map((a) => `\t\t<string>${xmlEscape(a)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LAUNCHD_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...programArgs,
    "\t</array>",
    "\t<key>StartInterval</key>",
    "\t<integer>60</integer>",
    "\t<key>RunAtLoad</key>",
    "\t<false/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xmlEscape(`${logDir}/job-tick.out.log`)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xmlEscape(`${logDir}/job-tick.err.log`)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function parseLaunchdPlist(text: string): SchedulerTarget | undefined {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!m) return undefined;
  const words = [...m[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) => xmlUnescape(x[1]!));
  if (words.length === 0) return undefined;
  return { executable: words[0]!, args: words.slice(1) };
}

async function isLoaded(ctx: SchedulerContext): Promise<boolean> {
  try {
    await ctx.execFile("launchctl", ["print", `gui/${ctx.uid}/${LAUNCHD_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

export async function installMacos(ctx: SchedulerContext, target: SchedulerTarget): Promise<{ files: string[] }> {
  const plist = launchAgentPath(ctx.homedir);
  await ctx.fs.mkdir(launchdLogDir(ctx.homedir), { recursive: true, mode: 0o700 });
  await writeFileAtomic(ctx, plist, generateLaunchdPlist(target, ctx.homedir));
  if (await isLoaded(ctx)) {
    await ctx.execFile("launchctl", ["bootout", `gui/${ctx.uid}/${LAUNCHD_LABEL}`]);
  }
  await ctx.execFile("launchctl", ["bootstrap", `gui/${ctx.uid}`, plist]);
  return { files: [plist] };
}

export async function uninstallMacos(ctx: SchedulerContext): Promise<{ removed: boolean }> {
  let removed = false;
  if (await isLoaded(ctx)) {
    await ctx.execFile("launchctl", ["bootout", `gui/${ctx.uid}/${LAUNCHD_LABEL}`]);
    removed = true;
  }
  if (await unlinkIfExists(ctx.fs, launchAgentPath(ctx.homedir))) removed = true;
  return { removed };
}

export async function statusMacos(
  ctx: SchedulerContext,
): Promise<{ installed: boolean; target?: SchedulerTarget; detail?: string; loaded?: boolean }> {
  const plist = launchAgentPath(ctx.homedir);
  const text = await readIfExists(ctx.fs, plist);
  if (text === undefined) return { installed: false };
  return { installed: true, target: parseLaunchdPlist(text), detail: plist, loaded: await isLoaded(ctx) };
}
