/**
 * T16 — Manual background-job tool.
 *
 * A single `run_background_job` tool exposes the core manual actions
 * (start/list/poll/log/wait/stop) against the T14 coordinator — the ONLY
 * entry point allowed to launch/observe/stop background jobs. This file
 * never imports supervisor/platform-adapter code directly.
 *
 * Opt-in gate: the tool is always registered (discoverable in /help and
 * tool schemas), but `execute()` refuses to do anything unless
 * `backgroundJobsEnabled: true` is set in the Agav config. This keeps the
 * feature truly opt-in without needing to thread a flag through
 * app.tsx/main.tsx's tool-list construction.
 *
 * Trust/capability tier: commands run outside the normal 30-second
 * `run_command` timeout and OUTSIDE the OS sandbox (seatbelt/bubblewrap)
 * used by `run_command` — the SAME trust boundary applies (same OS user),
 * per solution.md §4, but there is no per-call timeout and no sandboxing by
 * default. Jobs persist across the current turn and session.
 *
 * Phase-B limitation: no headless consent flow exists yet, so the
 * `SessionPolicySnapshot` built here always has `headlessApprovedActions: []`.
 */
import { platform as osPlatform } from "node:os";
import { randomUUID } from "node:crypto";

import type { ToolDefinition, ToolResult } from "./types.js";
import { loadConfig } from "../config/config.js";
import { getSharedCoordinator, getSharedScheduleEngine } from "../background-jobs-integration.js";
import {
  BackgroundJobError,
  DEFAULT_RESOURCE_LIMITS,
  type InvocationSpec,
  type JobSummary,
  type LaunchSpec,
  type SessionPolicySnapshot,
  type ShellInterpreter,
  type StartJobRequest,
} from "../background-jobs/types.js";

type Action =
  | "start"
  | "list"
  | "poll"
  | "log"
  | "wait"
  | "stop"
  | "schedule-create"
  | "schedule-list"
  | "schedule-revoke";

const DISABLED_MESSAGE =
  'Background jobs are not enabled. Set "backgroundJobsEnabled": true in your agav config to use this tool.';

function defaultShellInterpreter(): ShellInterpreter {
  return osPlatform() === "win32" ? "cmd" : "posix-sh";
}

function sessionPolicyFromConfig(permissionMode: SessionPolicySnapshot["permissionMode"]): SessionPolicySnapshot {
  return { permissionMode, headlessApprovedActions: [] };
}

function shortId(jobId: string): string {
  return jobId.length > 8 ? `${jobId.slice(0, 8)}…` : jobId;
}

function formatSummary(summary: JobSummary): string {
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

function formatList(summaries: JobSummary[]): string {
  if (summaries.length === 0) return "No background jobs found.";
  const header = "id (prefix, full id also works)  state              started              ended                exit";
  const rows = summaries.map((s) => {
    const id = shortId(s.jobId).padEnd(32);
    const state = s.state.padEnd(18);
    const started = (s.startedAt ?? "-").padEnd(20);
    const ended = (s.endedAt ?? "-").padEnd(20);
    const exit = s.exitCode === undefined || s.exitCode === null ? "-" : String(s.exitCode);
    return `${id} ${state} ${started} ${ended} ${exit}`;
  });
  return [header, ...rows].join("\n");
}

function mapBackgroundJobError(error: BackgroundJobError): string {
  switch (error.code) {
    case "authorization-denied":
      return "This action requires confirmation; it was not approved.";
    case "capacity-exceeded":
      return "Too many background jobs are already running (limit reached).";
    case "isolation-unavailable":
      return `Requested isolation backend is unavailable on this host: ${error.message}`;
    case "not-found":
      return `No matching background job was found: ${error.message}`;
    case "ambiguous-id":
      return `The job id prefix is ambiguous: ${error.message}`;
    case "spec-changed":
      return `That request id was already used with a different command: ${error.message}`;
    case "unsupported-platform":
      return `Background jobs are not supported on this platform: ${error.message}`;
    default:
      return error.message;
  }
}

function errorResult(message: string): ToolResult {
  return { output: message, isError: true };
}

export const backgroundJobTool: ToolDefinition = {
  schema: {
    name: "run_background_job",
    description:
      "Start, inspect and control long-running commands as background jobs, OUTSIDE the normal 30-second " +
      "run_command timeout and OUTSIDE the OS sandbox (seatbelt/bubblewrap) used by run_command — a different " +
      "trust/capability tier. Jobs persist across the current turn and session; use this for commands that must " +
      "keep running after this turn ends (servers, long builds, watchers). Requires \"backgroundJobsEnabled\": true " +
      "in the agav config; otherwise this tool refuses every action. Actions: " +
      "start (launch a new background job from a shell command), list (show all known jobs), " +
      "poll (show current state of one job), log (show captured output of one job), " +
      "wait (block, cancellably, until a job reaches a terminal state), stop (request termination of one job). " +
      "Also supports recurring process-schedules: schedule-create (register a cron-based schedule for a shell " +
      "command), schedule-list (show all known schedules), schedule-revoke (disable a schedule by exact id). Note: " +
      "creating a schedule only registers it — no periodic timer in this delivery automatically triggers it yet.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "list", "poll", "log", "wait", "stop", "schedule-create", "schedule-list", "schedule-revoke"],
          description: "Which operation to perform.",
        },
        command: {
          type: "string",
          description: "Shell command text to run in the background. Required for action:\"start\".",
        },
        jobId: {
          type: "string",
          description:
            "Job id or unambiguous id prefix. Required for poll/log/wait/stop; ignored for start/list.",
        },
        maxBytes: {
          type: "number",
          description: "Optional maximum bytes of log output to return for action:\"log\".",
        },
        cwd: {
          type: "string",
          description: "Working directory for action:\"start\". Defaults to the current working directory.",
        },
        cron: {
          type: "string",
          description:
            "5-field cron expression (minute hour day-of-month month day-of-week). Required for " +
            "action:\"schedule-create\".",
        },
        timezone: {
          type: "string",
          description:
            "IANA timezone name the cron expression is evaluated in, e.g. \"America/New_York\" or \"UTC\". " +
            "Required for action:\"schedule-create\".",
        },
        scheduleId: {
          type: "string",
          description:
            "Exact schedule id to revoke. Requires an exact match; no prefix lookup is supported. Required for " +
            "action:\"schedule-revoke\".",
        },
      },
      required: ["action"],
    },
  },

  async execute(input, context): Promise<ToolResult> {
    const action = input.action as Action | undefined;
    if (!action) {
      return errorResult('Missing required "action" parameter.');
    }

    let config;
    try {
      config = await loadConfig();
    } catch (error) {
      return errorResult(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (config.backgroundJobsEnabled !== true) {
      return errorResult(DISABLED_MESSAGE);
    }

    const session = context?.backgroundPolicy ?? sessionPolicyFromConfig(config.permissionMode);

    try {
      const coordinator = await getSharedCoordinator();

      switch (action) {
        case "start": {
          const command = typeof input.command === "string" ? input.command : undefined;
          if (!command || command.trim() === "") {
            return errorResult('Missing required "command" parameter for action:"start".');
          }
          const invocation: InvocationSpec = {
            mode: "shell",
            interpreter: defaultShellInterpreter(),
            commandText: command,
          };
          const request: StartJobRequest = {
            requestId: randomUUID(),
            invocation,
            cwd: typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : process.cwd(),
            // Phase-B default: no sandboxing requested for background jobs.
            // Explicitly approved unrestricted execution ("none") is the
            // simplest safe default here since this tool does not yet
            // expose an isolation-selection UI; the same trust boundary as
            // run_command already applies (same OS user).
            isolation: { backend: "none", required: false },
          };
          const summary = await coordinator.start(request, session);
          return {
            output:
              `Started background job ${summary.jobId} (state: ${summary.state}).\n` +
              `Check it later with: run_background_job action=poll jobId=${summary.jobId}`,
            isError: false,
          };
        }

        case "list": {
          const summaries = await coordinator.list();
          return { output: formatList(summaries), isError: false };
        }

        case "poll": {
          const jobId = typeof input.jobId === "string" ? input.jobId : undefined;
          if (!jobId) return errorResult('Missing required "jobId" parameter for action:"poll".');
          const summary = await coordinator.poll(jobId);
          return { output: formatSummary(summary), isError: false };
        }

        case "log": {
          const jobId = typeof input.jobId === "string" ? input.jobId : undefined;
          if (!jobId) return errorResult('Missing required "jobId" parameter for action:"log".');
          const maxBytes = input.maxBytes !== undefined ? Number(input.maxBytes) : undefined;
          const tail = await coordinator.log(jobId, { maxBytes });
          const note = tail.truncated ? "\n[output truncated]" : "";
          return { output: (tail.text || "(no output captured)") + note, isError: false };
        }

        case "wait": {
          const jobId = typeof input.jobId === "string" ? input.jobId : undefined;
          if (!jobId) return errorResult('Missing required "jobId" parameter for action:"wait".');
          const summary = await coordinator.wait(jobId, context?.signal);
          const note = summary.state === "running" || summary.state === "starting" || summary.state === "accepted"
            ? "\n(wait returned before reaching a terminal state — possibly cancelled)"
            : "";
          return { output: formatSummary(summary) + note, isError: false };
        }

        case "stop": {
          const jobId = typeof input.jobId === "string" ? input.jobId : undefined;
          if (!jobId) return errorResult('Missing required "jobId" parameter for action:"stop".');
          const summary = await coordinator.stop(jobId, session);
          return { output: formatSummary(summary), isError: false };
        }

        case "schedule-create": {
          const command = typeof input.command === "string" ? input.command : undefined;
          const cron = typeof input.cron === "string" ? input.cron : undefined;
          const timezone = typeof input.timezone === "string" ? input.timezone : undefined;
          if (!command || command.trim() === "") {
            return errorResult('Missing required "command" parameter for action:"schedule-create".');
          }
          if (!cron || cron.trim() === "") {
            return errorResult('Missing required "cron" parameter for action:"schedule-create".');
          }
          if (!timezone || timezone.trim() === "") {
            return errorResult('Missing required "timezone" parameter for action:"schedule-create".');
          }
          const launchSpecTemplate: Omit<LaunchSpec, "requestId" | "createdAt"> = {
            invocation: { mode: "shell", interpreter: defaultShellInterpreter(), commandText: command },
            cwd: typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : process.cwd(),
            env: {},
            credentialRefs: [],
            isolation: { backend: "none", required: false },
            ownershipScope: "unverified",
            limits: DEFAULT_RESOURCE_LIMITS,
            headless: false,
          };
          const scheduleEngine = await getSharedScheduleEngine();
          const schedule = await scheduleEngine.createSchedule({ cron, timezone, launchSpecTemplate, session });
          return {
            output:
              `Created schedule ${schedule.scheduleId} (cron: "${schedule.cron}", timezone: ${schedule.timezone}).\n` +
              `Check it with: run_background_job action=schedule-list\n` +
              `Revoke it with: run_background_job action=schedule-revoke scheduleId=${schedule.scheduleId}`,
            isError: false,
          };
        }

        case "schedule-list": {
          const scheduleEngine = await getSharedScheduleEngine();
          const schedules = await scheduleEngine.listSchedules();
          if (schedules.length === 0) return { output: "No schedules found.", isError: false };
          const lines = schedules.map((s) => {
            const commandSummary =
              s.launchSpecTemplate.invocation.mode === "shell" ? s.launchSpecTemplate.invocation.commandText : "(direct invocation)";
            return `${s.scheduleId}  [${s.enabled ? "enabled" : "disabled"}]  cron: "${s.cron}"  timezone: ${s.timezone}  command: ${commandSummary}`;
          });
          return { output: lines.join("\n"), isError: false };
        }

        case "schedule-revoke": {
          const scheduleId = typeof input.scheduleId === "string" ? input.scheduleId : undefined;
          if (!scheduleId) return errorResult('Missing required "scheduleId" parameter for action:"schedule-revoke".');
          const scheduleEngine = await getSharedScheduleEngine();
          const schedules = await scheduleEngine.listSchedules();
          const match = schedules.find((s) => s.scheduleId === scheduleId);
          if (!match) return errorResult(`No schedule found with id "${scheduleId}".`);
          await scheduleEngine.revokeSchedule(scheduleId, session);
          return {
            output:
              `Revoked schedule ${scheduleId}. Future launches from this schedule are blocked. ` +
              `This does not stop any job that was already launched by it.`,
            isError: false,
          };
        }

        default:
          return errorResult(`Unknown action: ${String(action)}`);
      }
    } catch (error) {
      if (error instanceof BackgroundJobError) {
        return errorResult(mapBackgroundJobError(error));
      }
      return errorResult(`Background job operation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
