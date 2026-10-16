import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { openResourceManager } from "./resource-manager.js";
import { getSharedCoordinator, getSharedScheduleEngine } from "../background-jobs-integration.js";
import type { Coordinator } from "../background-jobs/coordinator/index.js";
import { BackgroundJobError, isLiveLifecycle, type JobSummary, type SessionPolicySnapshot } from "../background-jobs/types.js";
import {
  describeBackgroundJobError,
  describeStopResult,
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
  "Note: by default schedules are checked about every 30 seconds, but only while an interactive agav session with background jobs enabled is running. If unattended automation is explicitly configured (`agav job tick --install` or `agav job daemon start`), schedules also fire while agav is closed.";

const LOG_USAGE = "Usage: /job log <id> [--stderr] [--tail N]";

/** A bare number is the deprecated `[maxBytes]` form, an alias of `--tail`. */
function parseLogArgs(args: string[]): { stream: "stdout" | "stderr"; streamExplicit: boolean; maxBytes?: number } | { error: string } {
  let stream: "stdout" | "stderr" = "stdout";
  let streamExplicit = false;
  let tail: number | undefined;
  let legacyMaxBytes: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--stderr") {
      stream = "stderr";
      streamExplicit = true;
    } else if (arg === "--stdout") {
      stream = "stdout";
      streamExplicit = true;
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
  return { stream, streamExplicit, maxBytes: tail ?? legacyMaxBytes };
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

/**
 * With no explicit stream, a failed job's reason usually sits in stderr, so append it
 * (and the exit code) rather than only reporting empty stdout. Best effort: a status
 * lookup failure must not hide the log itself.
 */
async function describeFailure(coordinator: Coordinator, id: string, maxBytes: number | undefined): Promise<string | undefined> {
  try {
    const summary = await coordinator.poll(id);
    if (summary.state !== "failed") return undefined;
    const exit = summary.exitCode === undefined || summary.exitCode === null ? "no exit code" : `exit code ${summary.exitCode}`;
    const stderr = await coordinator.log(id, { maxBytes, stream: "stderr" });
    const body = stderr.text.trimEnd();
    return `Job failed (${exit}).` + (body ? `\n── stderr ──\n${body}` : "\nNo stderr output was captured.");
  } catch {
    return undefined;
  }
}

function sessionFor(context: CommandContext): SessionPolicySnapshot {
  return {
    permissionMode: context.config.permissionMode,
    headlessApprovedActions: [],
    confirmBackgroundAction: context.confirmBackgroundAction,
  };
}

function message(text: string): CommandResult {
  return { type: "message", text };
}

/** Text commands can't prompt; when only confirmation was missing, open the manager, which can. */
async function confirmationNeeded(error: unknown, manualHint: string, context: CommandContext): Promise<CommandResult | undefined> {
  if (!(error instanceof BackgroundJobError) || error.code !== "authorization-denied"
    || !/interactive confirmation/i.test(error.message)) return undefined;
  const interactive = openResourceManager("jobs", context);
  if (interactive) {
    context.showStatus(`This action needs your approval. Opening the /job manager: ${manualHint}`);
    return interactive;
  }
  return message(`${describeBackgroundJobError(error)}\nUse the interactive /job manager to approve it (${manualHint}).`);
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
        const failure = parsed.streamExplicit ? undefined : await describeFailure(coordinator, id, parsed.maxBytes);
        const body = (tail.text || (failure ? "" : `(no ${parsed.stream} output captured)`)) + note;
        return message(failure ? [body.trimEnd(), failure].filter(Boolean).join("\n\n") : body);
      }

      if (action === "stop") {
        const id = parts[1];
        if (!id) return message("Usage: /job stop <id>");
        const summary = await coordinator.stop(id, sessionFor(context));
        if (summary.stopState === "none" && !isLiveLifecycle(summary.state)) return message(describeStopResult(summary));
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
          const session = sessionFor(context);
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
          const session = sessionFor(context);
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
      const sub = parts[1]?.toLowerCase();
      const hint = action === "stop" ? "select the job and press x to stop it"
        : sub === "create" ? "Tab to Schedules, then n to create the schedule"
        : sub === "revoke" ? "Tab to Schedules, select the schedule and press x to revoke it"
        : undefined;
      if (hint) {
        const needsApproval = await confirmationNeeded(error, hint, context);
        if (needsApproval) return needsApproval;
      }
      return message(describeBackgroundJobError(error));
    }
  },
};
