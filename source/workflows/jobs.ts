import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getAgavDir } from "../config/config.js";
import { ensureDir } from "../utils/fs.js";

/**
 * Registry of detached workflow runs.
 *
 * A scheduled run must outlive whatever started it: the terminal that launched
 * it, and eventually the daemon that triggered it. This mirrors the
 * background-process record so the two share an operational shape, but it is a
 * separate namespace on purpose. A workflow run owns rich state in
 * `run.json`, and folding shell jobs and workflow runs into one list would make
 * `list` ambiguous about what is actually running.
 *
 * The record exists only to answer three questions: is it alive, what started
 * it, and how do I stop it. Everything else lives in the workflow store.
 */

export type WorkflowJobStatus = "starting" | "running" | "finished";

export interface WorkflowJobRecord {
  id: string;
  /** The workflow run this job executes. */
  runId: string;
  /** Workflow name or path as supplied. */
  target: string;
  status: WorkflowJobStatus;
  startedAt: string;
  finishedAt?: string;
  /** OS process id of the detached child, used to stop it. */
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}

function jobsDir(): string {
  // Mirrors AGAV_BACKGROUND_PROCESS_DIR so a test or an alternate install can
  // redirect job state without touching the real run directory.
  return process.env["AGAV_WORKFLOW_JOB_DIR"] ?? join(getAgavDir(), "workflow-jobs");
}

function jobPath(id: string): string {
  return join(jobsDir(), `${id}.json`);
}

/**
 * Path a detached child watches for a stop request.
 *
 * An IPC pipe is not usable here: it dies with the spawning process, and the
 * entire point is that the parent exits while the run continues. A file is the
 * only channel that outlives it.
 *
 * Keyed by run id, because that is what both ends know: `stopWorkflowJob` reads
 * it from the record and the child reads it from `--run-id`.
 */
function stopRequestPath(runId: string): string {
  return join(jobsDir(), `${runId}.stop`);
}

/** Ask a detached run to stop. Returns false when the request could not be written. */
export async function requestStop(runId: string): Promise<boolean> {
  try {
    await ensureDir(jobsDir());
    await writeFile(stopRequestPath(runId), new Date().toISOString(), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Whether a stop has been requested for this run. */
export async function isStopRequested(runId: string): Promise<boolean> {
  try {
    await readFile(stopRequestPath(runId), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function clearStopRequest(runId: string): void {
  try {
    rmSync(stopRequestPath(runId), { force: true });
  } catch {
    // Nothing to clear.
  }
}

/**
 * Watch for a stop request and abort when one appears.
 *
 * Returns a disposer. The polling interval is short enough that a stop feels
 * prompt but long enough not to matter against a model call.
 */
export function watchForStopRequest(runId: string, onStop: () => void, intervalMs = 500): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void isStopRequested(runId).then((requested) => {
      if (!requested || stopped) return;
      stopped = true;
      onStop();
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

export async function readWorkflowJob(id: string): Promise<WorkflowJobRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(jobPath(id), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
      return parsed as WorkflowJobRecord;
    }
  } catch {
    // Missing or corrupt: treat as unknown rather than crashing a listing.
  }
  return null;
}

export async function listWorkflowJobs(): Promise<WorkflowJobRecord[]> {
  try {
    const names = await readdir(jobsDir());
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"))
        .map((name) => readWorkflowJob(name.slice(0, -".json".length))),
    );
    return records
      .filter((record): record is WorkflowJobRecord => record !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
}

/** Whether a job's child process is still alive. */
export function isWorkflowJobAlive(record: WorkflowJobRecord): boolean {
  if (record.status === "finished") return false;
  if (!record.pid) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(record.pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Jobs whose child is gone but which were never marked finished. */
export async function listOrphanedWorkflowJobs(): Promise<WorkflowJobRecord[]> {
  return (await listWorkflowJobs()).filter((record) => record.status !== "finished" && !isWorkflowJobAlive(record));
}

/**
 * Environment for the detached child.
 *
 * Secrets are stripped, matching the background-process runner. That is safe
 * here because provider credentials are encrypted at rest and decrypted by
 * `loadConfig()` in the child; env vars are not how the CLI reads them.
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key)) continue;
    env[key] = value;
  }

  // On Windows `process.env` is case-insensitive and enumerates as "Path",
  // which a child does not recognise as the search path. Without the canonical
  // spelling, anything the child resolves through PATH fails with ENOENT —
  // including nvm's node shim.
  const pathValue = env["PATH"] ?? env["Path"] ?? env["path"] ?? process.env["PATH"];
  if (pathValue) env["PATH"] = pathValue;

  return env;
}

function executableForRunner(): string {
  // Packaged runtimes can point at a specific Node binary; mirrors the
  // background-process runner.
  return process.env["AGAV_NODE"] || process.execPath;
}

export interface StartWorkflowJobOptions {
  /** Workflow name or path. */
  target: string;
  /** Pre-generated run id, so the job and the run agree. */
  runId: string;
  /** Serialized inputs for the run. */
  input?: Record<string, unknown>;
  cwd?: string;
  /** CLI entry to invoke. Defaults to the built CLI next to this module. */
  cliPath?: string;
}

/**
 * Launch a workflow in a detached child process.
 *
 * Detached and unref'd so the run survives the parent: closing the terminal that
 * started it must not abort work that is already in flight. The child's pid is
 * recorded immediately so the run stays stoppable.
 */
export async function startWorkflowJob(options: StartWorkflowJobOptions): Promise<WorkflowJobRecord> {
  await ensureDir(jobsDir());

  const id = randomUUID().slice(0, 8);
  const record: WorkflowJobRecord = {
    id,
    runId: options.runId,
    target: options.target,
    status: "starting",
    startedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(jobPath(id), record);

  // Absolute, and anchored to this module rather than the working directory: a
  // scheduler or daemon may run from anywhere, and a relative path would spawn a
  // child that cannot find the entry point.
  const cliPath = options.cliPath
    ? resolve(options.cliPath)
    : fileURLToPath(new URL("../cli.js", import.meta.url));
  const args = [cliPath, "workflows", "run", options.target, "--run-id", options.runId];

  if (options.input && Object.keys(options.input).length > 0) {
    args.push("--input-json", JSON.stringify(options.input));
  }

  const child = spawn(executableForRunner(), args, {
    cwd: options.cwd ?? process.cwd(),
    env: childEnv(),
    detached: true,
    // An IPC pipe keeps the child detached while letting stopWorkflowJob ask it
    // to checkpoint rather than terminating it outright.
    // No IPC pipe: it dies with this process, and the whole point is that the
    // parent exits. Stop requests arrive through a file the child polls.
    stdio: "ignore",
  });

  child.unref();

  // Without a listener, a failed spawn is an unhandled "error" event that
  // terminates the process. A launcher that cannot start its child must record
  // the failure, not die.
  let spawnFailure: string | undefined;
  child.on("error", (err) => { spawnFailure = err.message; });

  // Give the spawn a moment to fail, so a launch error is recorded rather than
  // leaving a job that claims to be running and never will be.
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("error", done);
    child.once("spawn", done);
    const timer = setTimeout(done, 500);
    timer.unref?.();
  });

  const outcome: WorkflowJobRecord = {
    ...record,
    status: spawnFailure ? "finished" : "running",
    ...(child.pid ? { pid: child.pid } : {}),
    ...(spawnFailure
      ? { finishedAt: new Date().toISOString(), error: `Failed to start: ${spawnFailure}` }
      : {}),
  };
  await writeJsonAtomic(jobPath(id), outcome);
  return { ...outcome };
}

/**
 * Mark the job record for `runId` finished, from inside the child that ran it.
 *
 * The parent that spawned the run has usually exited by the time the run ends, so
 * nobody else can close the record out — and a record left `running` makes the
 * overlap guard block a scheduled task forever. Guarded by pid, so a later run
 * reusing the same run id is never marked finished by an earlier child.
 *
 * Returns the record that was updated, or null when there was nothing to close.
 */
export async function markWorkflowJobFinishedByRunId(
  runId: string,
  outcome: { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string } = {},
): Promise<WorkflowJobRecord | null> {
  const jobs = await listWorkflowJobs();
  const record = jobs.find(
    (candidate) =>
      candidate.runId === runId &&
      candidate.status !== "finished" &&
      (candidate.pid === undefined || candidate.pid === process.pid),
  );
  if (!record) return null;
  return markWorkflowJobFinished(record.id, outcome);
}

/**
 * Stop a detached workflow run.
 *
 * Sends SIGTERM so the child can checkpoint cleanly. The workflow runtime traps
 * that signal through its RunController and records `cancelled`, leaving the run
 * resumable rather than half-written.
 */
export async function stopWorkflowJob(id: string): Promise<WorkflowJobRecord | null> {
  const record = await readWorkflowJob(id);
  if (!record) return null;
  if (record.status === "finished") return record;
  if (!record.pid) return record;

  try {
    // Ask rather than signal: the child polls for the request and checkpoints the
    // run as cancelled. Signalling would kill it mid-node on Windows, where
    // SIGTERM maps to TerminateProcess and no Node handler can run.
    await requestStop(record.runId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // Already gone; mark it finished so listings stop showing it as live.
      const finished: WorkflowJobRecord = {
        ...record,
        status: "finished",
        finishedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(jobPath(id), finished);
      return finished;
    }
    return record;
  }

  const stopping: WorkflowJobRecord = { ...record, status: "finished", finishedAt: new Date().toISOString(), signal: "SIGTERM" };
  await writeJsonAtomic(jobPath(id), stopping);
  return stopping;
}

/** Mark a job finished. Called by the supervising side once the child exits. */
export async function markWorkflowJobFinished(
  id: string,
  outcome: { exitCode?: number | null; signal?: string | null; error?: string } = {},
): Promise<WorkflowJobRecord | null> {
  const record = await readWorkflowJob(id);
  if (!record) return null;
  const finished: WorkflowJobRecord = {
    ...record,
    status: "finished",
    finishedAt: new Date().toISOString(),
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
  await writeJsonAtomic(jobPath(id), finished);
  return finished;
}

/** Remove finished job records older than `maxAgeMs`, keeping the directory bounded. */
export async function pruneWorkflowJobs(maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
  const jobs = await listWorkflowJobs();
  let removed = 0;
  for (const job of jobs) {
    if (job.status !== "finished" || !job.finishedAt) continue;
    if (now - Date.parse(job.finishedAt) < maxAgeMs) continue;
    try {
      const { rm } = await import("node:fs/promises");
      await rm(jobPath(job.id), { force: true });
      removed++;
    } catch {
      // A job we cannot delete is not worth failing over.
    }
  }
  return removed;
}

export function formatWorkflowJob(job: WorkflowJobRecord): string {
  const live = job.status !== "finished" && isWorkflowJobAlive(job);
  const state = job.status === "finished" ? job.signal ?? (job.exitCode === 0 ? "finished" : `exit ${job.exitCode ?? "?"}`) : live ? "running" : "orphaned";
  return `${job.id}  ${job.target}  run=${job.runId}  ${state}${job.error ? `  error=${job.error}` : ""}`;
}
