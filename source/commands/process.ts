/**
 * T16 — Manual `/process` slash command.
 *
 * Direct, user-facing inspection/control of background jobs WITHOUT going
 * through the LLM/tool-call path, per solution.md §2: "Add user-facing job
 * inspection and capability/status reporting without requiring an LLM
 * turn." This talks to the coordinator the exact same way the
 * `run_background_job` tool does (via the shared singleton in
 * `../background-jobs-integration.js`), and is gated by the same
 * `backgroundJobsEnabled` config flag.
 *
 * This file is intentionally separate from `./schedule.ts` (the old
 * prompt-schedule feature, unrelated and left untouched) and does not reuse
 * the `/schedule` name.
 */
import { platform as osPlatform } from "node:os";

import type { SlashCommand, CommandResult } from "./types.js";
import { getSharedCoordinator, getSharedScheduleEngine } from "../background-jobs-integration.js";
import {
  BackgroundJobError,
  DEFAULT_RESOURCE_LIMITS,
  type JobSummary,
  type LaunchSpec,
  type SessionPolicySnapshot,
} from "../background-jobs/types.js";

const DISABLED_MESSAGE =
  'Background jobs are not enabled. Set "backgroundJobsEnabled": true in your agav config to use /process.';

const USAGE =
  "Usage: /process <action>\n\n" +
  "  /process list                                       Show all known background jobs\n" +
  "  /process poll <id>                                  Show the current state of one job\n" +
  "  /process log <id> [maxBytes]                        Show captured output of one job\n" +
  "  /process stop <id>                                  Request termination of one job\n" +
  "  /process schedule list                              Show all registered schedules\n" +
  '  /process schedule create "<cron>" <timezone> <cmd>  Register a recurring background command\n' +
  "  /process schedule revoke <scheduleId>               Revoke a schedule by exact id (does not stop already-running jobs)\n" +
  "  /process capabilities                               Show platform capability/status report\n\n" +
  'Background jobs must be enabled via "backgroundJobsEnabled": true in your agav config.\n' +
  "Note: creating a schedule only registers it — no periodic timer in this delivery automatically triggers scheduled launches yet.";

function defaultShellInterpreter(): "posix-sh" | "cmd" {
  return osPlatform() === "win32" ? "cmd" : "posix-sh";
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
  const header = "id (prefix)                      state              started              ended                exit";
  const rows = summaries.map((s) => {
    const id = (s.jobId.length > 8 ? `${s.jobId.slice(0, 8)}…` : s.jobId).padEnd(32);
    const state = s.state.padEnd(18);
    const started = (s.startedAt ?? "-").padEnd(20);
    const ended = (s.endedAt ?? "-").padEnd(20);
    const exit = s.exitCode === undefined || s.exitCode === null ? "-" : String(s.exitCode);
    return `${id} ${state} ${started} ${ended} ${exit}`;
  });
  return [header, ...rows].join("\n");
}

function message(text: string): CommandResult {
  return { type: "message", text };
}

function mapBackgroundJobError(error: BackgroundJobError): string {
  switch (error.code) {
    case "authorization-denied":
      return "This action requires confirmation; it was not approved.";
    case "capacity-exceeded":
      return "Too many background jobs are already running (limit reached).";
    case "not-found":
      return `No matching background job was found: ${error.message}`;
    case "ambiguous-id":
      return `The job id prefix is ambiguous: ${error.message}`;
    case "unsupported-platform":
      return `Background jobs are not supported on this platform: ${error.message}`;
    default:
      return error.message;
  }
}

export const processCommand: SlashCommand = {
  name: "process",
  description: "Inspect and control background jobs (manual, opt-in subsystem)",
  usage: USAGE,

  async execute(args, context): Promise<CommandResult> {
    if (context.config.backgroundJobsEnabled !== true) {
      return message(DISABLED_MESSAGE);
    }

    const parts = args.trim().split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() ?? "";

    if (!action) {
      return message(USAGE);
    }

    try {
      const coordinator = await getSharedCoordinator();

      if (action === "list") {
        const summaries = await coordinator.list();
        return message(formatList(summaries));
      }

      if (action === "poll") {
        const id = parts[1];
        if (!id) return message("Usage: /process poll <id>");
        const summary = await coordinator.poll(id);
        return message(formatSummary(summary));
      }

      if (action === "log") {
        const id = parts[1];
        if (!id) return message("Usage: /process log <id> [maxBytes]");
        const maxBytes = parts[2] ? Number(parts[2]) : undefined;
        const tail = await coordinator.log(id, { maxBytes: Number.isFinite(maxBytes) ? maxBytes : undefined });
        const note = tail.truncated ? "\n[output truncated]" : "";
        return message((tail.text || "(no output captured)") + note);
      }

      if (action === "stop") {
        const id = parts[1];
        if (!id) return message("Usage: /process stop <id>");
        const summary = await coordinator.stop(id, {
          permissionMode: context.config.permissionMode,
          headlessApprovedActions: [],
        });
        return message(formatSummary(summary));
      }

      if (action === "capabilities") {
        const caps = await coordinator.capabilities();
        const lines = [
          `platform: ${caps.platform}`,
          `availableIsolationBackends: ${caps.availableIsolationBackends.join(", ") || "(none)"}`,
          `strongestOwnershipScope: ${caps.strongestOwnershipScope}`,
          `supportsGracefulApplicationShutdown: ${caps.supportsGracefulApplicationShutdown}`,
          `supportsDelegatedCgroup: ${caps.supportsDelegatedCgroup}`,
          `nativeHelperAvailable: ${caps.nativeHelperAvailable}`,
          caps.limitations.length > 0
            ? `limitations:\n  - ${caps.limitations.join("\n  - ")}`
            : "limitations: (none reported)",
        ];
        return message(lines.join("\n"));
      }

      if (action === "schedule") {
        const scheduleEngine = await getSharedScheduleEngine();
        const subAction = parts[1]?.toLowerCase();

        if (subAction === "list" || !subAction) {
          const schedules = await scheduleEngine.listSchedules();
          if (schedules.length === 0) return message("No schedules found.");
          const lines = schedules.map((s) => {
            const commandSummary =
              s.launchSpecTemplate.invocation.mode === "shell" ? s.launchSpecTemplate.invocation.commandText : "(direct invocation)";
            return `${s.scheduleId}  [${s.enabled ? "enabled" : "disabled"}]  cron: "${s.cron}"  timezone: ${s.timezone}  command: ${commandSummary}`;
          });
          return message(lines.join("\n"));
        }

        if (subAction === "create") {
          const rest = parts.slice(2).join(" ");
          const match = /^"([^"]+)"\s+(\S+)\s+(.+)$/.exec(rest);
          if (!match) {
            return message('Usage: /process schedule create "<cron>" <timezone> <command>');
          }
          const [, cron, timezone, command] = match;
          const launchSpecTemplate: Omit<LaunchSpec, "requestId" | "createdAt"> = {
            invocation: { mode: "shell", interpreter: defaultShellInterpreter(), commandText: command! },
            cwd: process.cwd(),
            env: {},
            credentialRefs: [],
            isolation: { backend: "none", required: false },
            ownershipScope: "unverified",
            limits: DEFAULT_RESOURCE_LIMITS,
            headless: false,
          };
          const session: SessionPolicySnapshot = { permissionMode: context.config.permissionMode, headlessApprovedActions: [] };
          const schedule = await scheduleEngine.createSchedule({ cron: cron!, timezone: timezone!, launchSpecTemplate, session });
          return message(
            `Created schedule ${schedule.scheduleId} (cron: "${schedule.cron}", timezone: ${schedule.timezone}).\n` +
              `List with: /process schedule list\n` +
              `Revoke with: /process schedule revoke ${schedule.scheduleId}`,
          );
        }

        if (subAction === "revoke") {
          const scheduleId = parts[2];
          if (!scheduleId) return message("Usage: /process schedule revoke <scheduleId>");
          const schedules = await scheduleEngine.listSchedules();
          const foundMatch = schedules.find((s) => s.scheduleId === scheduleId);
          if (!foundMatch) return message(`No schedule found with id "${scheduleId}".`);
          const session: SessionPolicySnapshot = { permissionMode: context.config.permissionMode, headlessApprovedActions: [] };
          await scheduleEngine.revokeSchedule(scheduleId, session);
          return message(
            `Revoked schedule ${scheduleId}. Future launches from this schedule are blocked. ` +
              `This does not stop any job that was already launched by it.`,
          );
        }

        return message(`Unknown /process schedule sub-action. ${USAGE}`);
      }

      return message(`Unknown action. ${USAGE}`);
    } catch (error) {
      if (error instanceof BackgroundJobError) {
        return message(mapBackgroundJobError(error));
      }
      return message(`Background job operation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
