import { platform as osPlatform } from "node:os";

import { getSharedCoordinator, getSharedScheduleEngine } from "../background-jobs-integration.js";
import type { ScheduleRun } from "../background-jobs/schedule/engine.js";
import { classifyOccurrence } from "../background-jobs/schedule/ownership.js";
import {
  BackgroundJobError,
  DEFAULT_RESOURCE_LIMITS,
  isLiveLifecycle,
  isScheduleRevoked,
  isTerminalLifecycle,
  type JobSummary,
  type LaunchSpec,
  type PlatformCapabilities,
  type ScheduleRecord,
  type SessionPolicySnapshot,
} from "../background-jobs/types.js";
import type { ResourceAdapter, ResourceItem } from "./types.js";

/** Shared by `/job` text output and the jobs resource manager. */
export function formatJobSummary(summary: JobSummary): string {
  const lines = [
    `jobId: ${summary.jobId}`,
    `requestId: ${summary.requestId}`,
    `state: ${summary.state}`,
    `stopState: ${summary.stopState}`,
  ];
  if (summary.startedAt) lines.push(`startedAt: ${summary.startedAt}`);
  if (summary.endedAt) lines.push(`endedAt: ${summary.endedAt}`);
  if (summary.exitCode !== undefined) lines.push(`exitCode: ${summary.exitCode}`);
  return lines.join("\n");
}

export function formatCapabilities(caps: PlatformCapabilities): string {
  return [
    `platform: ${caps.platform}`,
    `availableIsolationBackends: ${caps.availableIsolationBackends.join(", ") || "(none)"}`,
    `strongestOwnershipScope: ${caps.strongestOwnershipScope}`,
    `supportsGracefulApplicationShutdown: ${caps.supportsGracefulApplicationShutdown}`,
    `supportsDelegatedCgroup: ${caps.supportsDelegatedCgroup}`,
    `nativeHelperAvailable: ${caps.nativeHelperAvailable}`,
    caps.limitations.length > 0
      ? `limitations:\n  - ${caps.limitations.join("\n  - ")}`
      : "limitations: (none reported)",
  ].join("\n");
}

/** `stop()` leaves `stopState` at "none" when it found nothing live to stop (it never prompted). */
export function describeStopResult(summary: JobSummary): string {
  if (summary.stopState === "none" && !isLiveLifecycle(summary.state)) {
    return `Job ${shortId(summary.jobId)} is not running (state: ${summary.state}); there is nothing to stop.`;
  }
  return `Stop requested for ${shortId(summary.jobId)} (state: ${summary.state}, stop: ${summary.stopState}).`;
}

export function describeBackgroundJobError(error: unknown): string {
  if (!(error instanceof BackgroundJobError)) {
    return `Background job operation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  switch (error.code) {
    case "authorization-denied":
      return `This action requires confirmation; it was not approved. (${error.message})`;
    case "capacity-exceeded":
      return "Too many background jobs are already running (limit reached).";
    case "not-found":
      return `No matching background job was found: ${error.message}`;
    case "invalid-state":
      return error.message;
    case "ambiguous-id":
      return `The job id prefix is ambiguous: ${error.message}`;
    case "unsupported-platform":
      return `Background jobs are not supported on this platform: ${error.message}`;
    default:
      return error.message;
  }
}

export function scheduleCommandSummary(schedule: ScheduleRecord): string {
  const invocation = schedule.launchSpecTemplate.invocation;
  return invocation.mode === "shell" ? invocation.commandText : "(direct invocation)";
}

export function shellLaunchTemplate(commandText: string): Omit<LaunchSpec, "requestId" | "createdAt"> {
  return {
    invocation: { mode: "shell", interpreter: osPlatform() === "win32" ? "cmd" : "posix-sh", commandText },
    cwd: process.cwd(),
    env: {},
    credentialRefs: [],
    isolation: { backend: "none", required: false },
    ownershipScope: "unverified",
    limits: DEFAULT_RESOURCE_LIMITS,
    headless: false,
  };
}

/** The manager shows thrown messages verbatim, so translate subsystem errors first. */
async function friendly<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(describeBackgroundJobError(error));
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function displayTime(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "-";
}

/** Which schedule (if any) launched each job, keyed by the job's requestId. */
interface JobOrigins {
  byRequestId: Map<string, ScheduleRecord>;
  /** False when schedules could not be read, so origins are unknown rather than "independent". */
  known: boolean;
}

/** Best effort: a schedule-store failure must not break the jobs list. */
async function loadJobOrigins(): Promise<JobOrigins> {
  try {
    const engine = await getSharedScheduleEngine();
    const byRequestId = new Map<string, ScheduleRecord>();
    for (const schedule of await engine.listSchedules()) {
      for (const run of await engine.listRuns(schedule.scheduleId)) {
        byRequestId.set(run.occurrence.requestId, schedule);
      }
    }
    return { byRequestId, known: true };
  } catch {
    return { byRequestId: new Map(), known: false };
  }
}

const TITLE_COMMAND_MAX = 60;

/** One-line titles only; the detail view always shows the full command. */
function truncateCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > TITLE_COMMAND_MAX ? `${oneLine.slice(0, TITLE_COMMAND_MAX - 1)}…` : oneLine;
}

function jobItem(summary: JobSummary, origins?: JobOrigins): ResourceItem {
  const exit = summary.exitCode === undefined || summary.exitCode === null ? "-" : String(summary.exitCode);
  const schedule = origins?.byRequestId.get(summary.requestId);
  const known = origins?.known ?? false;
  const independentLabel = summary.command ? `independent run "${truncateCommand(summary.command)}"` : "independent run";
  const originLabel = schedule
    ? `schedule "${scheduleCommandSummary(schedule)}" (${schedule.cron})`
    : known ? independentLabel : "origin unknown";
  const originDetail = schedule
    ? `origin: schedule ${schedule.scheduleId} (cron: "${schedule.cron}", timezone: ${schedule.timezone}, command: ${scheduleCommandSummary(schedule)})`
    : known ? "origin: independent run (not launched by a schedule)" : "origin: unknown (schedules could not be loaded)";
  const originSearch = schedule ? `scheduled ${schedule.scheduleId}` : known ? "independent" : "";
  return {
    id: summary.jobId,
    title: `${shortId(summary.jobId)}  ${summary.state}  · ${originLabel}`,
    description: `started ${displayTime(summary.startedAt)} · ended ${displayTime(summary.endedAt)} · exit ${exit}`,
    detail: [
      formatJobSummary(summary),
      ...(summary.command ? [`command: ${summary.command}`] : []),
      ...(summary.cwd ? [`cwd: ${summary.cwd}`] : []),
      originDetail,
    ].join("\n"),
    searchText: [summary.jobId, summary.requestId, summary.state, originSearch, summary.command, summary.cwd].filter(Boolean).join(" "),
    stoppable: isLiveLifecycle(summary.state),
    // Display hint only; deleteJob() re-checks against fresh liveness evidence.
    removable: isTerminalLifecycle(summary.state),
  };
}

/** Newest first. Jobs not yet started were only just accepted, so they lead. */
export function sortJobsNewestFirst(summaries: JobSummary[]): JobSummary[] {
  return [...summaries].sort((a, b) => {
    if (a.startedAt && b.startedAt) return b.startedAt.localeCompare(a.startedAt);
    return Number(Boolean(a.startedAt)) - Number(Boolean(b.startedAt));
  });
}

const LOG_VIEW_BYTES = 64 * 1024;

function logSection(label: string, tail: { text: string; truncated: boolean }): string {
  const body = tail.text.trimEnd() || "(no output captured)";
  return `── ${label}${tail.truncated ? ` (last ${LOG_VIEW_BYTES / 1024} KB)` : ""} ──\n${body}`;
}

export function createJobsAdapter(): ResourceAdapter {
  return {
    title: "Background jobs",
    inspectLabel: "Details & logs",
    removeLabel: "Delete",
    removedLabel: "Deleted",
    removeConfirm: "This permanently removes the job, its logs and its saved command. This cannot be undone.",
    remove: (id) => deleteJob(id),
    list: () => friendly(async () => {
      const [summaries, origins] = await Promise.all([(await getSharedCoordinator()).list(), loadJobOrigins()]);
      return sortJobsNewestFirst(summaries).map((summary) => jobItem(summary, origins));
    }),
    // One view for everything about a job: summary, origin, then both streams
    // read tail-first so long-running jobs show their latest output.
    get: (id) => friendly(async () => {
      const coordinator = await getSharedCoordinator();
      const [summary, stdout, stderr, origins] = await Promise.all([
        coordinator.poll(id),
        coordinator.log(id, { maxBytes: LOG_VIEW_BYTES, stream: "stdout" }),
        coordinator.log(id, { maxBytes: LOG_VIEW_BYTES, stream: "stderr" }),
        loadJobOrigins(),
      ]);
      const item = jobItem(summary, origins);
      return { ...item, detail: `${item.detail}\n\n${logSection("stdout", stdout)}\n\n${logSection("stderr", stderr)}` };
    }),
  };
}

export async function stopJob(id: string, session: SessionPolicySnapshot): Promise<string> {
  return friendly(async () => {
    const summary = await (await getSharedCoordinator()).stop(id, session);
    return describeStopResult(summary);
  });
}

export async function deleteJob(id: string): Promise<void> {
  return friendly(async () => (await getSharedCoordinator()).deleteJob(id));
}

export const REVOKE_SCHEDULE_CONFIRM =
  "This is permanent: no future jobs will launch (already launched jobs keep running; the schedule stays listed as revoked).";

export async function revokeSchedule(id: string, session: SessionPolicySnapshot): Promise<string> {
  return friendly(async () => {
    await (await getSharedScheduleEngine()).revokeSchedule(id, session);
    return "Revoked.";
  });
}

export async function jobCapabilities(): Promise<string> {
  return friendly(async () => formatCapabilities(await (await getSharedCoordinator()).capabilities()));
}

const SCHEDULE_DETAIL_RUNS = 10;

/** A run is shown by its job when one launched, otherwise by why the trigger did not launch. */
function describeRun(run: ScheduleRun): string {
  if (!run.job) return `${displayTime(run.occurrence.createdAt)}  ${run.occurrence.status}${run.occurrence.reason ? ` (${run.occurrence.reason})` : ""}`;
  const exit = run.job.exitCode === undefined || run.job.exitCode === null ? "" : ` exit ${run.job.exitCode}`;
  return `${displayTime(run.job.startedAt ?? run.occurrence.createdAt)}  ${shortId(run.job.jobId)}  ${run.job.state}${exit}`;
}

function scheduleItem(s: ScheduleRecord, runs: ScheduleRun[]): ResourceItem {
  const revoked = isScheduleRevoked(s);
  const lastRun = runs[0] ? describeRun(runs[0]) : "never";
  return {
    id: s.scheduleId,
    title: `${scheduleCommandSummary(s)}${revoked ? " [revoked]" : ""}`,
    description: `${s.cron} · ${s.timezone} · last run ${lastRun}`,
    detail: [
      s.scheduleId,
      `Status: ${revoked ? "revoked" : s.enabled ? "enabled" : `paused since ${displayTime(s.pausedAt)}`}`,
      `Cron: ${s.cron}`,
      `Timezone: ${s.timezone}`,
      `Command: ${scheduleCommandSummary(s)}`,
      `Cwd: ${s.launchSpecTemplate.cwd}`,
      `Created: ${displayTime(s.createdAt)}`,
      `Last run: ${lastRun}`,
      "",
      runs.length ? `Recent runs (${Math.min(runs.length, SCHEDULE_DETAIL_RUNS)} of ${runs.length}):` : "No runs yet.",
      ...runs.slice(0, SCHEDULE_DETAIL_RUNS).map((run) => `  ${describeRun(run)}`),
    ].join("\n"),
    // Revocation is permanent: nothing left to toggle or revoke.
    enabled: revoked ? undefined : s.enabled,
    // Display hint only; deleteSchedule() re-checks under the schedule lock.
    // Same rule as the engine (schedule/ownership.ts). An expired jobless reservation does not block:
    // deleteSchedule() fences it before removing the schedule.
    removable: !s.enabled && !runs.some((run) => classifyOccurrence(run.occurrence, run.job, Date.now()) === "active"),
    searchText: `${s.scheduleId} ${s.cron} ${s.timezone}`,
  };
}

export function createJobSchedulesAdapter(session: SessionPolicySnapshot): ResourceAdapter {
  const list = () => friendly(async () => {
    const engine = await getSharedScheduleEngine();
    const schedules = await engine.listSchedules();
    return Promise.all(schedules.map(async (s) => scheduleItem(s, await engine.listRuns(s.scheduleId))));
  });
  return {
    title: "Background job schedules",
    list,
    get: async (id) => (await list()).find((item) => item.id === id),
    notice: "Disable pauses a schedule; Revoke (x) is permanent. Neither stops jobs already launched.",
    removeLabel: "Delete",
    removedLabel: "Deleted",
    removeConfirm: "This permanently removes the schedule and its run history. Jobs it already launched are kept.",
    remove: (id) => friendly(() => getSharedScheduleEngine().then((engine) => engine.deleteSchedule(id))),
    fields: [
      { name: "cron", label: "Cron (five fields)", required: true },
      { name: "timezone", label: "Timezone (IANA, e.g. UTC)", required: true },
      { name: "command", label: "Command", required: true },
    ],
    create: (values) => friendly(async () => {
      const schedule = await (await getSharedScheduleEngine()).createSchedule({
        cron: values.cron!.trim(),
        timezone: values.timezone!.trim(),
        launchSpecTemplate: shellLaunchTemplate(values.command!),
        session,
      });
      return `Created schedule ${schedule.scheduleId}.`;
    }),
    setEnabled: (id, enabled) => friendly(async () => { await (await getSharedScheduleEngine()).setScheduleEnabled(id, enabled, session); }),
  };
}
