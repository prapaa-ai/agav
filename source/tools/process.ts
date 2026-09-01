import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";
import { getAgavDir } from "../config/config.js";
import { ensureDir } from "../utils/fs.js";
import { isDestructiveCommand } from "../utils/sandbox.js";

const DEFAULT_LOG_LINES = 80;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;
const NOTIFY_POLL_MS = 2_000;

export type BackgroundProcessStatus = "starting" | "running" | "exited" | "failed" | "killed" | "error";

export interface BackgroundProcessRecord {
  id: string;
  command: string;
  cwd: string;
  status: BackgroundProcessStatus;
  startedAt: string;
  finishedAt?: string;
  pid?: number;
  runnerPid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutPath: string;
  stderrPath: string;
  error?: string;
  notifiedAt?: string;
}

export interface BackgroundProcessEvent {
  type: "completed";
  record: BackgroundProcessRecord;
}

const listeners = new Set<(event: BackgroundProcessEvent) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

const RUNNER_SCRIPT = String.raw`import { spawn } from "node:child_process";
import { openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const jobPath = process.argv[2];
if (!jobPath) process.exit(2);

function readJob() {
  return JSON.parse(readFileSync(jobPath, "utf8"));
}

function writeJob(job) {
  const tmp = jobPath + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, jobPath);
}

function filterEnv() {
  const out = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key)) continue;
    out[key] = val;
  }
  return out;
}

let job = readJob();
let child;
try {
  const stdout = openSync(job.stdoutPath, "a");
  const stderr = openSync(job.stderrPath, "a");
  child = spawn(job.command, {
    cwd: job.cwd,
    env: filterEnv(),
    shell: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
  });
  job = { ...job, status: "running", pid: child.pid, runnerPid: process.pid };
  writeJob(job);

  const stopChild = () => {
    try {
      const latest = readJob();
      writeJob({ ...latest, status: "killed", finishedAt: new Date().toISOString(), signal: "SIGTERM" });
    } catch {}
    try { child?.kill("SIGTERM"); } catch {}
  };
  process.on("SIGTERM", stopChild);
  process.on("SIGINT", stopChild);

  child.on("error", (err) => {
    const latest = readJob();
    writeJob({ ...latest, status: "error", error: err.message, finishedAt: new Date().toISOString() });
    process.exitCode = 1;
  });

  child.on("close", (code, signal) => {
    const latest = readJob();
    const status = latest.status === "killed" ? "killed" : code === 0 ? "exited" : "failed";
    writeJob({
      ...latest,
      status,
      exitCode: code,
      signal: latest.signal ?? signal,
      finishedAt: latest.finishedAt ?? new Date().toISOString(),
    });
  });
} catch (err) {
  try {
    const latest = readJob();
    writeJob({ ...latest, status: "error", error: err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() });
  } catch {}
  process.exitCode = 1;
}
`;

function getJobsDir(): string {
  return process.env["AGAV_BACKGROUND_PROCESS_DIR"] || join(getAgavDir(), "background-processes");
}

function getRunnerPath(): string {
  return join(getJobsDir(), "process-runner.mjs");
}

function jobPath(id: string): string {
  return join(getJobsDir(), `${id}.json`);
}

function writeJsonAtomicSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

async function ensureRunnerScript(): Promise<string> {
  const path = getRunnerPath();
  await ensureDir(dirname(path));
  await writeFile(path, RUNNER_SCRIPT);
  return path;
}

function filterEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key)) continue;
    env[key] = val;
  }
  return env;
}

function readRecordSync(path: string): BackgroundProcessRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
      return parsed as BackgroundProcessRecord;
    }
  } catch {}
  return null;
}

async function readRecord(idOrPrefix: string): Promise<BackgroundProcessRecord | null> {
  const direct = readRecordSync(jobPath(idOrPrefix));
  if (direct) return direct;
  const match = listBackgroundProcesses().find((record) => record.id.startsWith(idOrPrefix));
  return match ?? null;
}

function readLog(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function tailLines(text: string, lines: number): string {
  if (!text) return "";
  const parts = text.split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join("\n").trimEnd();
}

function parseLines(input: Record<string, unknown>): number {
  const raw = Number(input.lines ?? DEFAULT_LOG_LINES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LOG_LINES;
  return Math.min(1000, Math.floor(raw));
}

function parseWaitTimeout(input: Record<string, unknown>): number {
  const raw = Number(input.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.floor(raw));
}

function missing(field: string): ToolResult {
  return { output: `Missing required field: ${field}`, isError: true };
}

function formatDuration(record: BackgroundProcessRecord): string {
  const start = Date.parse(record.startedAt);
  const end = Date.parse(record.finishedAt ?? new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "unknown duration";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function summarizeStatus(record: BackgroundProcessRecord): string {
  if (record.status === "starting") return "starting";
  if (record.status === "running") return "running";
  if (record.status === "exited") return "exited 0";
  if (record.status === "failed") return `failed ${record.exitCode ?? "unknown"}`;
  if (record.status === "killed") return `killed${record.signal ? ` by ${record.signal}` : ""}`;
  return `error${record.error ? `: ${record.error}` : ""}`;
}

function isTerminal(record: BackgroundProcessRecord): boolean {
  return record.status === "exited" || record.status === "failed" || record.status === "killed" || record.status === "error";
}

function formatRecord(record: BackgroundProcessRecord): string {
  const pid = record.pid ? ` pid=${record.pid}` : "";
  return `${record.id} [${summarizeStatus(record)}]${pid} ${formatDuration(record)}\n  cwd: ${record.cwd}\n  command: ${record.command}`;
}

export function getBackgroundProcessOutputTail(record: BackgroundProcessRecord, lines: number): string {
  const stderr = tailLines(readLog(record.stderrPath), lines);
  if (stderr) return stderr;
  return tailLines(readLog(record.stdoutPath), lines);
}

function formatLog(record: BackgroundProcessRecord, lines: number): string {
  const stdout = tailLines(readLog(record.stdoutPath), lines);
  const stderr = tailLines(readLog(record.stderrPath), lines);
  const parts = [formatRecord(record)];
  if (stdout) parts.push(`\nstdout (last ${lines} lines):\n${stdout}`);
  if (stderr) parts.push(`\nstderr (last ${lines} lines):\n${stderr}`);
  if (!stdout && !stderr) parts.push("\nNo output captured yet.");
  return parts.join("\n");
}

function executableForRunner(): string {
  // In normal npm/tsx installs, process.execPath is Node. Packaged runtimes can
  // override this when they need a specific node binary to host daemon jobs.
  return process.env["AGAV_NODE"] || process.execPath;
}

async function startDaemonProcess(command: string, cwd: string): Promise<BackgroundProcessRecord> {
  await ensureDir(getJobsDir());
  const id = crypto.randomUUID().slice(0, 8);
  const record: BackgroundProcessRecord = {
    id,
    command,
    cwd,
    status: "starting",
    startedAt: new Date().toISOString(),
    stdoutPath: join(getJobsDir(), `${id}.stdout.log`),
    stderrPath: join(getJobsDir(), `${id}.stderr.log`),
  };
  await writeJsonAtomic(jobPath(id), record);

  const runnerPath = await ensureRunnerScript();
  const runner = spawn(executableForRunner(), [runnerPath, jobPath(id)], {
    cwd,
    env: filterEnv(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  runner.unref();
  const latest = await readRecord(id);
  const withRunner = { ...(latest ?? record), runnerPid: runner.pid };
  await writeJsonAtomic(jobPath(id), withRunner);
  return { ...withRunner };
}

export function listBackgroundProcesses(): BackgroundProcessRecord[] {
  const dir = getJobsDir();
  try {
    return readdirSync(dir)
      .filter((name) => /^[a-f0-9-]{8}\.json$/.test(name))
      .map((name) => readRecordSync(join(dir, name)))
      .filter((record): record is BackgroundProcessRecord => !!record)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  } catch {
    return [];
  }
}

export function terminateAllBackgroundProcesses(): void {
  for (const record of listBackgroundProcesses()) {
    if (record.status !== "running" && record.status !== "starting") continue;
    const next = { ...record, status: "killed" as const, finishedAt: new Date().toISOString(), signal: "SIGTERM" as NodeJS.Signals };
    writeJsonAtomicSync(jobPath(record.id), next);
    try { if (record.pid) process.kill(record.pid, "SIGTERM"); } catch {}
    try { if (record.runnerPid) process.kill(record.runnerPid, "SIGTERM"); } catch {}
  }
}

export async function refreshBackgroundProcessNotifications(): Promise<void> {
  for (const record of listBackgroundProcesses()) {
    if (!isTerminal(record) || record.notifiedAt) continue;
    for (const listener of listeners) listener({ type: "completed", record: { ...record } });
    await writeJsonAtomic(jobPath(record.id), { ...record, notifiedAt: new Date().toISOString() });
  }
}

function startNotificationPolling(): void {
  if (pollTimer) return;
  void refreshBackgroundProcessNotifications();
  pollTimer = setInterval(() => { void refreshBackgroundProcessNotifications(); }, NOTIFY_POLL_MS);
}

function stopNotificationPolling(): void {
  if (listeners.size > 0 || !pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

export function subscribeToProcessEvents(listener: (event: BackgroundProcessEvent) => void): () => void {
  listeners.add(listener);
  startNotificationPolling();
  return () => {
    listeners.delete(listener);
    stopNotificationPolling();
  };
}

async function waitForRecord(id: string, timeoutMs: number): Promise<BackgroundProcessRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const record = await readRecord(id);
    if (!record) return null;
    if (isTerminal(record)) return record;
    await new Promise((resolveDone) => setTimeout(resolveDone, 100));
  }
  return await readRecord(id);
}

export const processTool: ToolDefinition = {
  schema: {
    name: "process",
    description:
      "Manage daemon-backed long-running background shell commands. Start a command without blocking the main agent turn; " +
      "it keeps running after agav exits, can be reattached on restart, and completion is reported back to the main window. " +
      "Actions: start, list, poll, log, wait, kill.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: start, list, poll, log, wait, kill" },
        command: { type: "string", description: "Shell command to start in the daemon (required for action=start)" },
        id: { type: "string", description: "Background process id or unique prefix (required for poll/log/wait/kill)" },
        cwd: { type: "string", description: "Working directory for action=start. Defaults to the current project directory." },
        lines: { type: "number", description: "Number of log lines to return for action=log/wait. Defaults to 80; max 1000." },
        timeout_ms: { type: "number", description: "Maximum time to wait for action=wait. Defaults to 30000; max 600000." },
        signal: { type: "string", description: "Signal to send for action=kill. Defaults to SIGTERM." },
      },
      required: ["action"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const action = String(input.action ?? "").toLowerCase();

    if (action === "start") {
      const command = String(input.command ?? "").trim();
      if (!command) return missing("command");
      if (isDestructiveCommand(command)) {
        return {
          output: `Blocked: "${command}" matches a destructive command pattern. This command requires explicit user confirmation and cannot be auto-approved.`,
          isError: true,
        };
      }
      const cwd = input.cwd ? resolve(String(input.cwd)) : process.cwd();
      const record = await startDaemonProcess(command, cwd);
      return {
        output:
          `Started daemon background process ${record.id}${record.runnerPid ? ` (runner pid ${record.runnerPid})` : ""}.\n` +
          `It will keep running after agav exits and will reattach on restart. Use process action "poll" or "log" with id "${record.id}" for updates.\n` +
          `Command: ${record.command}`,
        isError: false,
      };
    }

    if (action === "list") {
      const records = listBackgroundProcesses();
      return { output: records.length ? records.map(formatRecord).join("\n\n") : "No background processes.", isError: false };
    }

    const id = String(input.id ?? "").trim();
    if (!id) return missing("id");
    const record = await readRecord(id);
    if (!record) return { output: `Background process not found: ${id}`, isError: true };

    if (action === "poll") {
      return { output: formatRecord(record), isError: record.status === "error" };
    }

    if (action === "log") {
      return { output: formatLog(record, parseLines(input)), isError: record.status === "error" };
    }

    if (action === "wait") {
      const timeoutMs = parseWaitTimeout(input);
      const latest = await waitForRecord(record.id, timeoutMs);
      if (!latest || !isTerminal(latest)) {
        return { output: `Background process ${record.id} is still running after ${timeoutMs}ms.`, isError: false };
      }
      return { output: formatLog(latest, parseLines(input)), isError: latest.status === "failed" || latest.status === "error" };
    }

    if (action === "kill") {
      if (isTerminal(record)) return { output: `Background process ${record.id} is already ${summarizeStatus(record)}.`, isError: false };
      const signal = String(input.signal ?? "SIGTERM") as NodeJS.Signals;
      const next = { ...record, status: "killed" as const, signal, finishedAt: new Date().toISOString() };
      try {
        await writeJsonAtomic(jobPath(record.id), next);
        let sent = false;
        if (record.pid) {
          try { process.kill(record.pid, signal); sent = true; } catch {}
        }
        if (record.runnerPid) {
          try { process.kill(record.runnerPid, signal); sent = true; } catch {}
        }
        return { output: sent ? `Sent ${signal} to background process ${record.id}.` : `Marked background process ${record.id} killed; no live pid was reachable.`, isError: false };
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true };
      }
    }

    return { output: "Unknown action. Use: start | list | poll | log | wait | kill", isError: true };
  },
};

export async function resetBackgroundProcessesForTests(): Promise<void> {
  terminateAllBackgroundProcesses();
  await new Promise((resolveDone) => setTimeout(resolveDone, 50));
  listeners.clear();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  try { rmSync(getJobsDir(), { recursive: true, force: true }); } catch {}
}
