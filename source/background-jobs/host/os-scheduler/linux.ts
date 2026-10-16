import type { SchedulerContext, SchedulerTarget } from "./common.js";
import { errorMessage, readIfExists, unlinkIfExists, writeFileAtomic } from "./common.js";

export const SYSTEMD_SERVICE_NAME = "agav-job-tick.service";
export const SYSTEMD_TIMER_NAME = "agav-job-tick.timer";
export const CRON_TAG = "# agav-job-tick";

export function systemdUserDir(homedir: string): string {
  return `${homedir}/.config/systemd/user`;
}

export function quoteSystemdArg(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg.replace(/%/g, "%%");
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function quoteShellArg(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_@+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function generateSystemdService(target: SchedulerTarget): string {
  const execStart = [target.executable, ...target.args].map(quoteSystemdArg).join(" ");
  // Lifetime/ownership: the tick spawns detached supervisors (and their workloads) that must
  // outlive this oneshot. `detached: true` only creates a new process group/session; it does NOT
  // leave the service's cgroup, and the default KillMode=control-group makes systemd kill every
  // process in that cgroup once the tick exits. KillMode=process limits the stop-time kill to the
  // main tick process, so launched jobs keep running (their own supervisors own their lifecycle).
  // SendSIGKILL=no is belt and braces: no SIGKILL sweep of leftover cgroup members after a timeout.
  return [
    "[Unit]",
    "Description=Agav background jobs tick",
    "",
    "[Service]",
    "Type=oneshot",
    "KillMode=process",
    "SendSIGKILL=no",
    `ExecStart=${execStart}`,
    "",
  ].join("\n");
}

export function generateSystemdTimer(): string {
  return [
    "[Unit]",
    "Description=Run the Agav background jobs tick every minute",
    "",
    "[Timer]",
    "OnCalendar=minutely",
    "Persistent=false",
    `Unit=${SYSTEMD_SERVICE_NAME}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

export function generateCronLine(target: SchedulerTarget): string {
  // cron turns unescaped `%` into newlines; `\%` reaches the shell as `%`.
  const cmd = [target.executable, ...target.args].map(quoteShellArg).join(" ").replace(/%/g, "\\%");
  return `* * * * * ${cmd} >/dev/null 2>&1 ${CRON_TAG}`;
}

function isTagged(line: string): boolean {
  return line.trimEnd().endsWith(CRON_TAG);
}

export function updateCrontab(existing: string, line: string | undefined): string {
  const kept = existing.split("\n").filter((l) => !isTagged(l));
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  if (line !== undefined) kept.push(line);
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

export function parseSystemdService(text: string): SchedulerTarget | undefined {
  const line = text.split("\n").find((l) => l.startsWith("ExecStart="));
  if (!line) return undefined;
  const words = splitQuoted(line.slice("ExecStart=".length), "systemd");
  if (words.length === 0) return undefined;
  return { executable: words[0]!, args: words.slice(1) };
}

export function parseCronLine(line: string): SchedulerTarget | undefined {
  let body = line.trimEnd();
  if (!body.endsWith(CRON_TAG)) return undefined;
  body = body.slice(0, -CRON_TAG.length).trim().replace(/\s*>\/dev\/null 2>&1$/, "");
  const fields = body.split(/\s+/);
  if (fields.length < 6) return undefined;
  const cmd = body.replace(/^(\S+\s+){5}/, "").replace(/\\%/g, "%");
  const words = splitQuoted(cmd, "shell");
  if (words.length === 0) return undefined;
  return { executable: words[0]!, args: words.slice(1) };
}

function splitQuoted(input: string, mode: "systemd" | "shell"): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
      continue;
    }
    has = true;
    if (mode === "shell" && ch === "'") {
      const end = input.indexOf("'", i + 1);
      cur += input.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          cur += input[i + 1];
          i += 2;
        } else {
          cur += input[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (mode === "shell" && ch === "\\" && i + 1 < input.length) {
      cur += input[i + 1];
      i += 2;
      continue;
    }
    cur += ch;
    i++;
  }
  if (has) out.push(cur);
  return mode === "systemd" ? out.map((w) => w.replace(/%%/g, "%").replace(/\$\$/g, "$")) : out;
}

export type LinuxBackend = "systemd" | "cron";

export interface LinuxInstallResult {
  backend: LinuxBackend;
  files: string[];
}

async function systemdUserAvailable(ctx: SchedulerContext): Promise<boolean> {
  try {
    await ctx.execFile("systemctl", ["--user", "show-environment"]);
    return true;
  } catch {
    return false;
  }
}

async function readCrontab(ctx: SchedulerContext): Promise<string> {
  try {
    return (await ctx.execFile("crontab", ["-l"])).stdout;
  } catch (error) {
    // `crontab -l` exits 1 with "no crontab for <user>" when none exists.
    if (/no crontab/i.test(errorMessage(error))) return "";
    throw error;
  }
}

async function writeCrontab(ctx: SchedulerContext, content: string): Promise<void> {
  const file = `${ctx.homedir}/.agav/agav-job-tick.crontab.tmp`;
  await writeFileAtomic(ctx, file, content, 0o600);
  try {
    await ctx.execFile("crontab", [file]);
  } finally {
    await unlinkIfExists(ctx.fs, file).catch(() => false);
  }
}

export async function installLinux(ctx: SchedulerContext, target: SchedulerTarget): Promise<LinuxInstallResult> {
  if (await systemdUserAvailable(ctx)) {
    const dir = systemdUserDir(ctx.homedir);
    const service = `${dir}/${SYSTEMD_SERVICE_NAME}`;
    const timer = `${dir}/${SYSTEMD_TIMER_NAME}`;
    await writeFileAtomic(ctx, service, generateSystemdService(target));
    await writeFileAtomic(ctx, timer, generateSystemdTimer());
    await ctx.execFile("systemctl", ["--user", "daemon-reload"]);
    await ctx.execFile("systemctl", ["--user", "enable", "--now", SYSTEMD_TIMER_NAME]);
    // Keep exactly one entry: drop a stale cron fallback from an earlier install.
    await removeCronEntry(ctx).catch(() => false);
    return { backend: "systemd", files: [service, timer] };
  }
  const existing = await readCrontab(ctx);
  const next = updateCrontab(existing, generateCronLine(target));
  if (next !== existing) await writeCrontab(ctx, next);
  return { backend: "cron", files: [] };
}

async function removeCronEntry(ctx: SchedulerContext): Promise<boolean> {
  let existing: string;
  try {
    existing = await readCrontab(ctx);
  } catch {
    return false; // no crontab binary → nothing to remove
  }
  if (!existing.split("\n").some(isTagged)) return false;
  await writeCrontab(ctx, updateCrontab(existing, undefined));
  return true;
}

export async function uninstallLinux(ctx: SchedulerContext): Promise<{ removed: boolean }> {
  let removed = false;
  const dir = systemdUserDir(ctx.homedir);
  const service = `${dir}/${SYSTEMD_SERVICE_NAME}`;
  const timer = `${dir}/${SYSTEMD_TIMER_NAME}`;
  const hasUnits = (await readIfExists(ctx.fs, timer)) !== undefined || (await readIfExists(ctx.fs, service)) !== undefined;
  if (hasUnits) {
    if (await systemdUserAvailable(ctx)) {
      await ctx.execFile("systemctl", ["--user", "disable", "--now", SYSTEMD_TIMER_NAME]).catch(() => undefined);
    }
    removed = (await unlinkIfExists(ctx.fs, timer)) || removed;
    removed = (await unlinkIfExists(ctx.fs, service)) || removed;
    if (await systemdUserAvailable(ctx)) {
      await ctx.execFile("systemctl", ["--user", "daemon-reload"]);
    }
  }
  if (await removeCronEntry(ctx)) removed = true;
  return { removed };
}

export async function statusLinux(
  ctx: SchedulerContext,
): Promise<{ installed: boolean; backend?: LinuxBackend; target?: SchedulerTarget; detail?: string }> {
  const service = `${systemdUserDir(ctx.homedir)}/${SYSTEMD_SERVICE_NAME}`;
  const timerFile = `${systemdUserDir(ctx.homedir)}/${SYSTEMD_TIMER_NAME}`;
  const serviceText = await readIfExists(ctx.fs, service);
  if (serviceText !== undefined && (await readIfExists(ctx.fs, timerFile)) !== undefined) {
    return { installed: true, backend: "systemd", target: parseSystemdService(serviceText), detail: service };
  }
  let crontab = "";
  try {
    crontab = await readCrontab(ctx);
  } catch {
    // crontab missing → not installed via cron
  }
  const line = crontab.split("\n").find(isTagged);
  if (line) return { installed: true, backend: "cron", target: parseCronLine(line), detail: "crontab" };
  return { installed: false };
}
