/**
 * T16 — Manual `/job` slash command.
 *
 * Direct, user-facing inspection/control of background jobs WITHOUT going
 * through the LLM/tool-call path, per solution.md §2: "Add user-facing job
 * inspection and capability/status reporting without requiring an LLM
 * turn." This talks to the coordinator the exact same way the
 * `run_background_job` tool does (via the shared singleton in
 * `../background-jobs-integration.js`), and is gated by the same
 * `backgroundJobsEnabled` config flag.
 *
 * A bare `/job` opens the shared resource manager (see `JobsTUI`) like the
 * other manager commands; the text sub-commands remain for headless use.
 *
 * This file is intentionally separate from `./schedule.ts` (the old
 * prompt-schedule feature, unrelated and left untouched) and does not reuse
 * the `/schedule` name.
 */
import type { SlashCommand, CommandResult } from "./types.js";
import { openResourceManager } from "./resource-manager.js";
import { getSharedCoordinator, getSharedScheduleEngine } from "../background-jobs-integration.js";
import type { JobSummary, SessionPolicySnapshot } from "../background-jobs/types.js";
import {
  describeBackgroundJobError,
  formatCapabilities,
  formatJobSummary,
  scheduleCommandSummary,
  shellLaunchTemplate,
} from "../resources/job-adapters.js";

const DISABLED_MESSAGE =
  'Background jobs are not enabled. Set "backgroundJobsEnabled": true in your agav config to use /job.';

const USAGE =
  "Usage: /job [action]\n\n" +
  "  /job                                            Open manager (usage in headless mode)\n" +
  "  /job list                                       Show all known background jobs\n" +
  "  /job poll <id>                                  Show the current state of one job\n" +
  "  /job log <id> [--stderr] [--tail N]             Show captured output of one job (first 64 KiB, or last N bytes)\n" +
  "  /job stop <id>                                  Request termination of one job\n" +
  "  /job schedule list                              Show all registered schedules\n" +
  '  /job schedule create "<cron>" <timezone> <cmd>  Register a recurring background command\n' +
  "  /job schedule revoke <scheduleId>               Revoke a schedule by exact id (does not stop already-running jobs)\n" +
  "  /job capabilities                               Show platform capability/status report\n\n" +
  'Background jobs must be enabled via "backgroundJobsEnabled": true in your agav config.\n' +
  "Note: schedules are checked about every 30 seconds, but only while an interactive agav session with background jobs enabled is running. Nothing triggers them while agav is closed.";

const LOG_USAGE = "Usage: /job log <id> [--stderr] [--tail N]";

/**
 * Parses the arguments after `/job log <id>`. `--stderr` picks the stream and
 * `--tail N` (or `--tail=N`) asks for the last N bytes. A bare number is still
 * accepted as the old `[maxBytes]` form. It's a deprecated alias of `--tail`.
 */
function parseLogArgs(args: string[]): { stream: "stdout" | "stderr"; maxBytes?: number } | { error: string } {
  let stream: "stdout" | "stderr" = "stdout";
  let tail: number | undefined;
  let legacyMaxBytes: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--stderr") {
      stream = "stderr";
    } else if (arg === "--stdout") {
      stream = "stdout";
    } else if (arg === "--tail" || arg.startsWith("--tail=")) {
      const raw = arg === "--tail" ? args[++i] : arg.slice("--tail=".length);
      const value = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: `--tail needs a positive whole number of bytes. ${LOG_USAGE}` };
      }
      tail = value;
    } else if (!arg.startsWith("--")) {
      const value = Number(arg);
      legacyMaxBytes = Number.isFinite(value) ? value : undefined;
    } else {
      return { error: `Unknown option "${arg}". ${LOG_USAGE}` };
    }
  }
  return { stream, maxBytes: tail ?? legacyMaxBytes };
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

export const jobCommand: SlashCommand = {
  name: "job",
  description: "Inspect and control background jobs (manual, opt-in subsystem)",
  usage: USAGE,

  async execute(args, context): Promise<CommandResult> {
    if (context.config.backgroundJobsEnabled !== true) {
      return message(DISABLED_MESSAGE);
    }

    const parts = args.trim().split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() ?? "";

    if (!action) {
      const interactive = openResourceManager("jobs", context);
      if (interactive) return interactive;
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
        if (!id) return message("Usage: /job poll <id>");
        const summary = await coordinator.poll(id);
        return message(formatJobSummary(summary));
      }

      if (action === "log") {
        const id = parts[1];
        if (!id) return message(LOG_USAGE);
        const parsed = parseLogArgs(parts.slice(2));
        if ("error" in parsed) return message(parsed.error);
        const tail = await coordinator.log(id, { maxBytes: parsed.maxBytes, stream: parsed.stream });
        const note = tail.truncated ? "\n[output truncated]" : "";
        return message((tail.text || `(no ${parsed.stream} output captured)`) + note);
      }

      if (action === "stop") {
        const id = parts[1];
        if (!id) return message("Usage: /job stop <id>");
        const summary = await coordinator.stop(id, {
          permissionMode: context.config.permissionMode,
          headlessApprovedActions: [],
        });
        return message(formatJobSummary(summary));
      }

      if (action === "capabilities") {
        return message(formatCapabilities(await coordinator.capabilities()));
      }

      if (action === "schedule") {
        const scheduleEngine = await getSharedScheduleEngine();
        const subAction = parts[1]?.toLowerCase();

        if (subAction === "list" || !subAction) {
          const schedules = await scheduleEngine.listSchedules();
          if (schedules.length === 0) return message("No schedules found.");
          const lines = schedules.map(
            (s) =>
              `${s.scheduleId}  [${s.enabled ? "enabled" : "disabled"}]  cron: "${s.cron}"  timezone: ${s.timezone}  command: ${scheduleCommandSummary(s)}`,
          );
          return message(lines.join("\n"));
        }

        if (subAction === "create") {
          const rest = parts.slice(2).join(" ");
          const match = /^"([^"]+)"\s+(\S+)\s+(.+)$/.exec(rest);
          if (!match) {
            return message('Usage: /job schedule create "<cron>" <timezone> <command>');
          }
          const [, cron, timezone, command] = match;
          const session: SessionPolicySnapshot = { permissionMode: context.config.permissionMode, headlessApprovedActions: [] };
          const schedule = await scheduleEngine.createSchedule({
            cron: cron!,
            timezone: timezone!,
            launchSpecTemplate: shellLaunchTemplate(command!),
            session,
          });
          return message(
            `Created schedule ${schedule.scheduleId} (cron: "${schedule.cron}", timezone: ${schedule.timezone}).\n` +
              `List with: /job schedule list\n` +
              `Revoke with: /job schedule revoke ${schedule.scheduleId}`,
          );
        }

        if (subAction === "revoke") {
          const scheduleId = parts[2];
          if (!scheduleId) return message("Usage: /job schedule revoke <scheduleId>");
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

        return message(`Unknown /job schedule sub-action. ${USAGE}`);
      }

      return message(`Unknown action. ${USAGE}`);
    } catch (error) {
      return message(describeBackgroundJobError(error));
    }
  },
};
