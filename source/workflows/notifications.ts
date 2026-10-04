import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgavDir } from "../config/config.js";
import { WorkflowStore } from "./store.js";
import type { WorkflowRun, WorkflowRunStatus } from "./types.js";

/**
 * Completion reporting for runs that finish where nobody is watching.
 *
 * A scheduled run executes detached from any terminal, so its result has nowhere
 * to appear unless something reports it. This mirrors the background-process
 * record: a run carries `notifiedAt`, and delivery happens exactly once — on
 * this poll if the session is live, or on a later session if it was not.
 *
 * Deliberately dependency-free. Sinks are plain functions so a caller can add
 * OS-level notification without this module taking a dependency on it.
 */

export type WorkflowRunEvent = {
  type: "completed";
  runId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  error?: string;
};

/**
 * A delivery target for a finished run.
 *
 * May return whether it delivered, so a caller can decide on a fallback.
 * Returning a value is optional; callers that do not care simply ignore it.
 */
export type WorkflowNotificationSink = (event: WorkflowRunEvent) => void | boolean | Promise<void | boolean>;

const listeners = new Set<WorkflowNotificationSink>();
let pollTimer: NodeJS.Timeout | null = null;

/** Statuses that mean the run is over and its result is worth reporting. */
const REPORTABLE: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([
  "passed",
  "failed",
  "cancelled",
  "timed_out",
]);

function isReportable(status: WorkflowRunStatus): boolean {
  return REPORTABLE.has(status);
}

function notificationsPath(): string {
  return join(getAgavDir(), "notifications.log");
}

/** Shape both a persisted run and a completion event satisfy. */
interface CompletionLike {
  workflowName: string;
  status: WorkflowRunStatus;
  error?: string;
}

export function formatRunCompletion(run: CompletionLike, runId?: string): string {
  const head = `${run.status === "passed" ? "✓" : "✗"} ${run.workflowName}${runId ? ` (${runId})` : ""} — ${run.status}`;
  return run.error ? `${head}\n  ${run.error}` : head;
}

/**
 * Ring the terminal bell.
 *
 * The one notification that needs no daemon and no desktop session, so it is the
 * right fallback on a box where `notify-send` is unavailable.
 */
export function terminalBellSink(): void {
  if (!process.stdout.isTTY) return;
  // BEL is understood by every terminal that has one; harmless otherwise.
  process.stdout.write("\u0007");
}
/**
 * Report a finished run through the desktop notification centre.
 *
 * Returns whether it was delivered, so a caller can tell the difference between
 * "shown" and "this box has no notification daemon". The durable log is
 * written regardless, so a failed desktop notification never loses the result.
 */
export async function desktopNotificationSink(event: WorkflowRunEvent): Promise<boolean> {
  const { formatDesktopNotification, notifyDesktop } = await import("../utils/desktop-notify.js");
  const result = await notifyDesktop(formatDesktopNotification(event));
  return result.delivered;
}
/**
 * Append to the always-on log.
 *
 * This is the sink that makes headless reporting truthful: a run on a machine
 * with no terminal leaves a durable record even if nothing else is wired up.
 */
export async function appendNotificationLog(event: WorkflowRunEvent): Promise<void> {
  await mkdir(getAgavDir(), { recursive: true });
  const line = `${new Date().toISOString()} ${formatRunCompletion(event, event.runId)}\n`;
  await appendFile(notificationsPath(), line, "utf8");
}

export async function readNotifications(limit = 50): Promise<string[]> {
  try {
    const raw = await readFile(notificationsPath(), "utf8");
    const lines = raw.split("\n").filter((entry) => entry.trim().length > 0);
    return limit > 0 ? lines.slice(-limit) : lines;
  } catch {
    return [];
  }
}

/** Clear the notification log. Used by tests and by an explicit operator action. */
export async function clearNotifications(): Promise<void> {
  try {
    await writeFile(notificationsPath(), "", "utf8");
  } catch {
    // Nothing to clear.
  }
}

async function emit(event: WorkflowRunEvent): Promise<void> {
  for (const sink of listeners) {
    // One broken sink must not stop the others from being told.
    try {
      await sink(event);
    } catch {
      // Swallowed deliberately: notification is best-effort by definition.
    }
  }
}

/**
 * Report every terminal run that has not been reported yet, then stamp it.
 *
 * Safe to call often: a run already stamped `notifiedAt` is skipped, so repeated
 * polls neither repeat a message nor lose one. The stamp is written after the
 * sinks run, which means a sink that throws leaves the run unstamped and it
 * will be retried on the next poll. That favours a duplicate message over a
 * silent loss.
 */
export async function refreshWorkflowRunNotifications(
  store = new WorkflowStore(),
  extraSinks: WorkflowNotificationSink[] = [],
): Promise<WorkflowRunEvent[]> {
  const delivered: WorkflowRunEvent[] = [];

  let runs: WorkflowRun[];
  try {
    runs = await store.listRuns();
  } catch {
    return [];
  }

  for (const run of runs) {
    if (!isReportable(run.status)) continue;
    if (run.notifiedAt) continue;

    const event: WorkflowRunEvent = {
      type: "completed",
      runId: run.id,
      workflowName: run.workflowName,
      status: run.status,
      ...(run.error ? { error: run.error } : {}),
    };

    await appendNotificationLog(event);
    await emit(event);
    for (const sink of extraSinks) {
      try {
        await sink(event);
      } catch {
        // Same rationale as above.
      }
    }

    delivered.push(event);
    await store.saveRun({ ...run, notifiedAt: new Date().toISOString() });
  }

  return delivered;
}

const NOTIFY_POLL_MS = 5_000;

/**
 * Subscribe to completion events.
 *
 * The returned unsubscribe stops the shared poll once nobody is listening, so a
 * headless caller that never subscribes pays nothing.
 */
export function subscribeToWorkflowRunEvents(
  listener: WorkflowNotificationSink,
  options: { store?: WorkflowStore; extraSinks?: WorkflowNotificationSink[] } = {},
): () => void {
  listeners.add(listener);
  if (!pollTimer) {
    const poll = () => {
      void refreshWorkflowRunNotifications(options.store ?? new WorkflowStore(), options.extraSinks);
    };
    poll();
    pollTimer = setInterval(poll, NOTIFY_POLL_MS);
    // Do not hold the process open purely to watch for notifications.
    pollTimer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

/** Stop the shared poll. Exposed for tests and clean shutdown. */
export function stopWorkflowRunNotificationPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

