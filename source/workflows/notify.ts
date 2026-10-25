import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createExclusive } from "../background-jobs/storage/atomic-file.js";
import { scopedCheckpoints, visitJobScope, type WorkflowRun, type WorkflowStore } from "./store.js";
import { shortId } from "./format.js";

/**
 * Workflow-local mailbox (`<agavDir>/workflow-runs/_mailbox/`). The shared job mailbox's
 * `CompletionEventRecord` is keyed by a jobId with a job outcome, so it cannot carry a run-level record
 * without changing shared types. Notifications are create-once files; a session presents one only after
 * winning its create-once `<id>.seen` marker, so each notification is shown exactly once across sessions.
 */
export type WorkflowNotificationKind = "waiting_approval" | "passed" | "failed" | "cancelled" | "timed_out";
export interface WorkflowNotification { id: string; runId: string; kind: WorkflowNotificationKind; text: string; createdAt: string }

const NOTIFIABLE = new Set<string>(["waiting_approval", "passed", "failed", "cancelled", "timed_out"]);
const NOTIFICATION_ID = /^wfn_[a-f0-9]{24}$/;

export function mailboxDir(store: WorkflowStore): string { return join(store.root, "_mailbox"); }
export const shortRunId = shortId;

/** The notification text for the run's current status, or undefined when the status is not announced. */
export function notificationFor(run: WorkflowRun): Omit<WorkflowNotification, "id" | "createdAt"> & { key: string } | undefined {
  if (!NOTIFIABLE.has(run.status)) return undefined;
  const kind = run.status as WorkflowNotificationKind;
  const short = shortRunId(run.id);
  if (kind === "waiting_approval") {
    // Loop body nodes count too (labelled with their iteration); loop containers themselves are not gates.
    const waiting = scopedCheckpoints(run).filter(visit => visit.cp.status === "waiting_approval" && visit.node.type !== "loop").map(visit => {
      const path = visitJobScope(visit)?.loopPath.map(step => step.iteration + 1).join(".");
      return { cp: visit.cp, label: path ? `${visit.cp.id} (iteration ${path})` : visit.cp.id, scope: path ?? "" };
    });
    // One notification per distinct set of open decisions, so a later park on another gate is announced again.
    const key = waiting.map(({ cp, scope }) => `${scope ? `${scope}/` : ""}${cp.id}:${cp.decisionId ?? ""}`).join(",");
    return { runId: run.id, kind, key, text: `Run ${short} waiting for approval: ${waiting.map(item => item.label).join(", ") || "(unknown node)"}` };
  }
  const label = kind === "timed_out" ? "timed out" : kind;
  return { runId: run.id, kind, key: "", text: `Run ${short} ${label}` };
}

/** Posts the run's status notification once (idempotent per run/status/waiting set). Best effort: never throws. */
export async function postRunNotification(store: WorkflowStore, run: WorkflowRun): Promise<WorkflowNotification | undefined> {
  try {
    const base = notificationFor(run);
    if (!base) return undefined;
    const id = `wfn_${createHash("sha256").update([base.runId, base.kind, base.key].join("\0")).digest("hex").slice(0, 24)}`;
    const record: WorkflowNotification = { id, runId: base.runId, kind: base.kind, text: base.text, createdAt: new Date().toISOString() };
    await createExclusive(join(mailboxDir(store), `${id}.json`), JSON.stringify(record) + "\n");
    return record;
  } catch {
    return undefined; // a notification never affects execution
  }
}

/**
 * Notifications not yet presented by any session, oldest first. Each returned one has been claimed for
 * `sessionId` (its `.seen` marker), so the caller must show it; other sessions will never return it.
 */
export async function claimUnseenNotifications(store: WorkflowStore, sessionId: string): Promise<WorkflowNotification[]> {
  const dir = mailboxDir(store);
  let names: string[];
  try { names = await fs.readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const seen = new Set(names.filter(name => name.endsWith(".seen")).map(name => name.slice(0, -5)));
  const claimed: WorkflowNotification[] = [];
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!NOTIFICATION_ID.test(id) || seen.has(id)) continue;
    let record: WorkflowNotification;
    try { record = JSON.parse(await fs.readFile(join(dir, name), "utf8")) as WorkflowNotification; }
    catch { continue; }
    if (!record || record.id !== id || typeof record.text !== "string") continue;
    if (await createExclusive(join(dir, `${id}.seen`), JSON.stringify({ sessionId, seenAt: new Date().toISOString() }) + "\n")) claimed.push(record);
  }
  return claimed.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
