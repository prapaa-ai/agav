import type { SchedulerContext, SchedulerTarget } from "./common.js";
import { errorMessage, unlinkIfExists, writeFileAtomic } from "./common.js";

export const WINDOWS_TASK_NAME = "\\Agav\\JobTick";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

export function splitWindowsArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "\\") {
      let n = 0;
      while (input[i] === "\\") {
        n++;
        i++;
      }
      if (input[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else {
          inQuotes = !inQuotes;
        }
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      has = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      has = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** `startBoundary` is a fixed past date so output is deterministic. */
export function generateTaskXml(target: SchedulerTarget, startBoundary = "2000-01-01T00:00:00"): string {
  const args = target.args.map(quoteWindowsArg).join(" ");
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Agav background jobs tick</Description>",
    `    <URI>${xmlEscape(WINDOWS_TASK_NAME)}</URI>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <TimeTrigger>",
    "      <Repetition>",
    "        <Interval>PT1M</Interval>",
    "        <StopAtDurationEnd>false</StopAtDurationEnd>",
    "      </Repetition>",
    `      <StartBoundary>${startBoundary}</StartBoundary>`,
    "      <Enabled>true</Enabled>",
    "    </TimeTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>false</StartWhenAvailable>",
    "    <Hidden>true</Hidden>",
    "    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlEscape(quoteWindowsArg(target.executable))}</Command>`,
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

export function parseTaskXml(xml: string): SchedulerTarget | undefined {
  const cmd = /<Command>([\s\S]*?)<\/Command>/.exec(xml);
  if (!cmd) return undefined;
  const argsMatch = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml);
  const executable = splitWindowsArgs(xmlUnescape(cmd[1]!.trim()))[0] ?? xmlUnescape(cmd[1]!.trim());
  const args = argsMatch ? splitWindowsArgs(xmlUnescape(argsMatch[1]!.trim())) : [];
  return { executable, args };
}

/** schtasks needs UTF-16LE with BOM when the XML declares UTF-16. */
export function encodeUtf16Le(text: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

export async function installWindows(ctx: SchedulerContext, target: SchedulerTarget): Promise<{ files: string[] }> {
  const file = `${ctx.homedir}\\.agav\\agav-job-tick.task.xml`;
  await writeFileAtomic(ctx, file, encodeUtf16Le(generateTaskXml(target)));
  try {
    await ctx.execFile("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", file, "/F"]);
  } finally {
    await unlinkIfExists(ctx.fs, file).catch(() => false);
  }
  return { files: [] };
}

function isMissingTask(error: unknown): boolean {
  return /cannot find|does not exist|not found/i.test(errorMessage(error));
}

export async function uninstallWindows(ctx: SchedulerContext): Promise<{ removed: boolean }> {
  try {
    await ctx.execFile("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
    return { removed: true };
  } catch (error) {
    if (isMissingTask(error)) return { removed: false };
    throw error;
  }
}

export async function statusWindows(
  ctx: SchedulerContext,
): Promise<{ installed: boolean; target?: SchedulerTarget; detail?: string }> {
  let xml: string;
  try {
    xml = (await ctx.execFile("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/XML"])).stdout;
  } catch (error) {
    if (isMissingTask(error)) return { installed: false };
    throw error;
  }
  return { installed: true, target: parseTaskXml(xml), detail: WINDOWS_TASK_NAME };
}
