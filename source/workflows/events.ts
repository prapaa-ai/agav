import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { NodeStatus, RunStatus, WorkflowStore } from "./store.js";

/** Display-only trace (`<runDir>/events.jsonl`); run.json remains the source of truth. */
export type WorkflowEvent =
  | { type: "node_started"; nodeId: string; attempt?: number }
  | { type: "node_retry"; nodeId: string; attempt: number; error?: string }
  | { type: "node_completed"; nodeId: string; status: NodeStatus; error?: string }
  | { type: "run_status"; status: RunStatus; reason?: string }
  | { type: "loop_iteration_started"; nodeId: string; iteration: number }
  | { type: "loop_iteration_completed"; nodeId: string; iteration: number; status: NodeStatus }
  | { type: "decision_requested"; nodeId: string; decisionId: string; kind: string }
  | { type: "decision_applied"; nodeId: string; decisionId: string; decision: "approve" | "deny"; decidedBy: string };
export type WorkflowEventRecord = WorkflowEvent & { at: string };

export function eventsPath(store: WorkflowStore, runId: string): string { return join(store.runDir(runId), "events.jsonl"); }

/** Appends one JSON line. Events are best-effort: a failed write never affects execution. */
export async function appendEvent(store: WorkflowStore, runId: string, event: WorkflowEvent): Promise<void> {
  try {
    await fs.mkdir(store.runDir(runId), { recursive: true, mode: 0o700 });
    await fs.appendFile(eventsPath(store, runId), JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  } catch { /* display-only trace */ }
}

/** Reads the trace; a torn or corrupt line (e.g. a crash mid-append) is skipped. */
export async function readEvents(store: WorkflowStore, runId: string): Promise<WorkflowEventRecord[]> {
  let text: string;
  try { text = await fs.readFile(eventsPath(store, runId), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const events: WorkflowEventRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { events.push(JSON.parse(line) as WorkflowEventRecord); } catch { /* torn line */ }
  }
  return events;
}
