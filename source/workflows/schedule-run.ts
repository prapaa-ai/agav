import { processTool } from "../tools/process.js";
import {
  loadScheduledTasks,
  saveScheduledTask,
  cronMatches,
  type ScheduledTask,
} from "../config/scheduler.js";
import { isWorkflowJobAlive, listWorkflowJobs, listOrphanedWorkflowJobs, markWorkflowJobFinished, startWorkflowJob } from "./jobs.js";
import { applyDecision, formatTaskStatus, planTick, type TickDecision } from "./schedule-plan.js";

/**
 * Executes schedule decisions.
 *
 * Separated from `planTick` so the rules stay pure and testable, and so a headless
 * daemon and the interactive session run identical behaviour: both call `tick`
 * with the same dependencies, and neither holds the logic.
 */

export interface TickDeps {
  /** Whether the task's previous run is still going. */
  isTaskRunning?: (task: ScheduledTask) => boolean;
  /** Start a workflow run, detached. Returns the run id. */
  startWorkflow?: (task: ScheduledTask) => Promise<string | null>;
  /** Start a long-running shell command. Returns a message for the operator. */
  startProcess?: (task: ScheduledTask) => Promise<string>;
  /** Submit a prompt to an interactive session. */
  submitPrompt?: (task: ScheduledTask) => void | Promise<void>;
  /** Report a message to the operator, if a session is attached. */
  report?: (message: string, isError?: boolean) => void;
  now?: () => Date;
}

/** Whether a workflow task's most recent detached run is still alive. */
export async function isWorkflowTaskRunning(task: ScheduledTask): Promise<boolean> {
  if (task.kind !== "workflow") return false;
  const jobs = await listWorkflowJobs();
  return jobs.some((job) => job.target === (task.workflow ?? task.prompt) && isWorkflowJobAlive(job));
}

async function defaultStartWorkflow(task: ScheduledTask): Promise<string | null> {
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
  const job = await startWorkflowJob({
    target: task.workflow ?? task.prompt,
    runId,
    ...(task.input ? { input: task.input } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
  });
  return job.runId;
}

async function defaultStartProcess(task: ScheduledTask): Promise<string> {
  const result = await processTool.execute({
    action: "start",
    command: task.command ?? task.prompt,
    cwd: task.cwd ?? process.cwd(),
  });
  return String(result.output);
}

/**
 * Evaluate the schedule once and act on what is due.
 *
 * Safe to call often: a task that already consumed the current minute is not
 * started again, so a 30-second poll and a one-shot `scheduler tick` behave the
 * same.
 */
export async function tick(deps: TickDeps = {}): Promise<TickDecision[]> {
  const now = deps.now?.() ?? new Date();
  const tasks = await loadScheduledTasks();

  // planTick is synchronous, so liveness is resolved first. Only workflow tasks
  // need a check; the others have no detached run to collide with.
  const running = new Set<string>();
  const probe = deps.isTaskRunning ?? isWorkflowTaskRunning;
  for (const task of tasks) {
    if (await probe(task)) running.add(task.id);
  }
  const decisions = planTick(tasks, now, (task) => running.has(task.id), cronMatches);

  // Reconcile orphans before acting. A job whose child died without closing its
  // record out stays `running` forever, and the overlap guard trusts that record,
  // so a scheduled task would be skipped on a run that is no longer going. This is
  // what wedged a task into reporting "already running" every tick.
  const orphans = await listOrphanedWorkflowJobs();
  for (const orphan of orphans) {
    await markWorkflowJobFinished(orphan.id, { error: "child exited without closing its job record" });
  }
  if (orphans.length > 0) {
    // Re-probe and re-plan against the corrected liveness, so a task that was only
    // stuck because of a stale record gets to fire this tick rather than waiting a
    // whole minute for the next one.
    running.clear();
    for (const task of tasks) {
      if (await probe(task)) running.add(task.id);
    }
    const corrected = planTick(tasks, now, (task) => running.has(task.id), cronMatches);
    decisions.length = 0;
    decisions.push(...corrected);
  }

  for (const decision of decisions) {
    if (decision.fire) {
      // Re-check liveness here rather than only before planTick. Two ticks in the
      // same minute both read the task as idle otherwise, because the first has
      // not yet spawned, and both fire — the overlap the guard exists to prevent.
      const probe = deps.isTaskRunning ?? isWorkflowTaskRunning;
      if (decision.task.skipIfRunning !== false && (await probe(decision.task))) {
        deps.report?.(`Schedule "${decision.task.name}" skipped: previous run started moments ago`, true);
      } else {
        await fire(decision, deps);
      }
    } else if (decision.skip && decision.skip !== "disabled" && decision.skip !== "already-fired") {
      // Never silent: a task that did not run says why.
      deps.report?.(`Schedule "${decision.task.name}" skipped: ${decision.skip}`, decision.skip !== "already-running");
    }
    const updated = applyDecision(decision.task, decision, now);
    if (updated !== decision.task) await saveScheduledTask(updated);
  }

  return decisions;
}

async function fire(decision: TickDecision, deps: TickDeps): Promise<void> {
  const task = decision.task;
  const late = decision.catchUp ? ` (${decision.minutesLate}m late)` : "";

  try {
    if (task.kind === "workflow") {
      const start = deps.startWorkflow ?? defaultStartWorkflow;
      const runId = await start(task);
      deps.report?.(`Scheduled workflow "${task.name}" started${late}${runId ? ` · run ${runId}` : ""}`);
      return;
    }
    if (task.kind === "process") {
      const start = deps.startProcess ?? defaultStartProcess;
      const message = await start(task);
      deps.report?.(`Scheduled background process "${task.name}"${late}\n${message}`);
      return;
    }
    const submit = deps.submitPrompt;
    if (!submit) {
      // No session to submit into. Report rather than pretend it ran.
      deps.report?.(`Schedule "${task.name}" is due${late} but no interactive session is attached`, true);
      return;
    }
    await submit(task);
  } catch (err) {
    deps.report?.(
      `Schedule "${task.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

/** Render the schedule for `agav scheduler list`. */
export function formatScheduleLine(task: ScheduledTask): string {
  const kind = task.kind ?? "prompt";
  const target = kind === "workflow" ? (task.workflow ?? task.prompt) : kind === "process" ? (task.command ?? task.prompt) : task.prompt;
  const state = task.enabled ? "" : " [disabled]";
  return `${task.id}  [${kind}]  ${task.name}  ${task.cron}  ${target}${state}\n      ${formatTaskStatus(task)}`;
}

export type { TickDecision } from "./schedule-plan.js";
