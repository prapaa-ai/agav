import { promises as fs } from "node:fs";
import { extname } from "node:path";
import { parseDocument } from "yaml";

import type { AgavConfig } from "../config/config.js";
import { writeAtomic } from "../background-jobs/storage/atomic-file.js";
import type { ToolRegistry } from "../tools/registry.js";
import { loadDefinition, parseDefinitionText, validateDefinition, walkNodes, type WorkflowDefinition, type WorkflowInputSpec, type WorkflowNode } from "../workflows/definition.js";
import { discoverWorkflows, type DiscoveredWorkflow } from "../workflows/discovery.js";
import { listPendingDecisions, type PendingDecision } from "../workflows/decisions.js";
import { readEvents, type WorkflowEventRecord } from "../workflows/events.js";
import { formatDuration, formatRunTree, isTerminalRunStatus, shortId, statusGlyph, truncateOutput } from "../workflows/format.js";
import { scopedCheckpoints, visitJobScope, type WorkflowRun, type WorkflowStore } from "../workflows/store.js";
import { cancelRun, decideRunDecision, decisionSummary } from "../workflows/control.js";
import { launchRun, type LaunchDeps } from "../workflows/launch.js";
import { assertBackgroundRunsAvailable, cancelJobDeps, launchSummary, listRuns, prepareLaunch, startBackgroundRun, type PreparedLaunch } from "../workflows/background.js";
import type { JobCoordinatorLike } from "../workflows/job-node.js";
import type { ResourceAdapter, ResourceField, ResourceItem } from "./types.js";

/** Everything the workflow screens need; the app passes the shared coordinator, tests a fake one. */
export interface WorkflowResourceDeps {
  store: WorkflowStore;
  registry: ToolRegistry;
  cwd: string;
  /** Override for `~/.agav/workflows` (tests). */
  userDir?: string;
  config: Pick<AgavConfig, "permissionMode" | "maxConcurrentWorkflowRuns" | "sandboxRequired">;
  getCoordinator(): Promise<JobCoordinatorLike & LaunchDeps["coordinator"]>;
  cliPath(): Promise<string>;
  sandboxRequired?: boolean;
}

const EVENT_TAIL = 10;
const LOG_EVENTS = 200;
const LOG_OUTPUT_CHARS = 4000;

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function age(iso: string, now = Date.now()): string {
  return `${formatDuration(now - Date.parse(iso))} ago`;
}

/** `10:45:03 node_started run_tests attempt=2` */
export function formatEvent(event: WorkflowEventRecord): string {
  const { at, type, ...rest } = event as WorkflowEventRecord & Record<string, unknown>;
  const { nodeId, ...fields } = rest as Record<string, unknown>;
  const extra = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return [clock(at), type, typeof nodeId === "string" ? nodeId : undefined, ...extra].filter(Boolean).join(" ");
}

// ── Workflows (definitions) ──────────────────────────────────────────────────

function describeNode(node: WorkflowNode): string {
  const deps = node.dependsOn?.length ? ` ← ${node.dependsOn.join(", ")}` : "";
  const when = node.when ? ` when ${node.when}` : "";
  switch (node.type) {
    case "tool": return `${node.id}  tool ${node.tool ?? "?"}${deps}${when}`;
    case "job": return `${node.id}  job $ ${node.command ?? ""}${deps}${when}`;
    case "approval": return `${node.id}  approval "${truncateOutput(node.prompt ?? "", 60)}"${deps}${when}`;
    case "agent": return `${node.id}  agent ${node.agent ?? "?"}${node.model ? ` · ${node.model}` : ""}${deps}${when}`;
    case "prompt": return `${node.id}  prompt${node.model ? ` · ${node.model}` : ""}${deps}${when}`;
    case "loop": {
      const stop = node.until ? ` until ${node.until}` : node.stopWhen ? ` stop when ${node.stopWhen.node} ${node.stopWhen.status}` : "";
      return `${node.id}  loop max ${node.maxIterations ?? "?"}${stop}${deps}${when}`;
    }
    default: return `${node.id}  ${String(node.type)}`;
  }
}

function inputLine(name: string, spec: WorkflowInputSpec): string {
  const flags = [spec.type, spec.required ? "required" : undefined, spec.default !== undefined ? `default ${JSON.stringify(spec.default)}` : undefined].filter(Boolean).join(", ");
  return `  ${name} (${flags})${spec.description ? ` — ${spec.description}` : ""}`;
}

export function formatDefinitionDetail(found: Pick<DiscoveredWorkflow, "name" | "path" | "origin">, definition: WorkflowDefinition, runs: WorkflowRun[] = []): string {
  const lines = [`${definition.name}  [${found.origin}]`, `Source: ${found.path}`];
  if (definition.description) lines.push("", definition.description);
  const inputs = Object.entries(definition.inputs ?? {});
  lines.push("", inputs.length ? "Inputs:" : "Inputs: (untyped; any JSON object)", ...inputs.map(([name, spec]) => inputLine(name, spec)));
  lines.push("", "Nodes:");
  walkNodes(definition, (node, path) => lines.push(`${"  ".repeat(path.length + 1)}${describeNode(node)}`));
  const policies = definition.policies ? Object.entries(definition.policies).map(([key, value]) => `${key}=${JSON.stringify(value)}`) : [];
  if (policies.length) lines.push("", `Policies: ${policies.join(", ")}`);
  const mine = runs.filter((run) => run.definition.name === definition.name).slice(0, 5);
  lines.push("", mine.length ? "Recent runs:" : "No runs yet.", ...mine.map((run) => `  ${statusGlyph(run.status)} ${shortId(run.id)}  ${run.status}  ${run.createdAt}`));
  return lines.join("\n");
}

function definitionValues(definition: WorkflowDefinition): Record<string, string> {
  return { name: definition.name, description: definition.description ?? "", inputs: definition.inputs ? JSON.stringify(definition.inputs) : "" };
}

/** The editable simple fields of a definition (graph editing is out of scope). */
export const WORKFLOW_EDIT_FIELDS: ResourceField[] = [
  { name: "name", label: "Name", required: true },
  { name: "description", label: "Description" },
  { name: "inputs", label: "Inputs (JSON object, empty for none)" },
];

/**
 * Rewrites only `name`, `description` and `inputs` of a definition file, validating the result first. YAML is
 * edited through its document model so comments and layout elsewhere survive; the write is atomic.
 */
export async function updateDefinitionFields(path: string, values: Record<string, string>, registry: ToolRegistry): Promise<void> {
  const text = await fs.readFile(path, "utf8");
  const name = values.name?.trim() ?? "";
  if (!name) throw new Error("Name is required.");
  if (/[\r\n]/.test(values.description ?? "")) throw new Error("Description must be one line.");
  const description = values.description?.trim() ?? "";
  let inputs: unknown;
  if (values.inputs?.trim()) {
    try { inputs = JSON.parse(values.inputs); } catch { throw new Error("Inputs must be a JSON object."); }
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("Inputs must be a JSON object.");
  }
  const yaml = [".yaml", ".yml"].includes(extname(path).toLowerCase());
  let next: string;
  if (yaml) {
    const doc = parseDocument(text);
    doc.set("name", name);
    if (description) doc.set("description", description); else doc.delete("description");
    if (inputs !== undefined) doc.set("inputs", inputs); else doc.delete("inputs");
    next = String(doc);
  } else {
    const data = parseDefinitionText(text, path) as Record<string, unknown>;
    data.name = name;
    if (description) data.description = description; else delete data.description;
    if (inputs !== undefined) data.inputs = inputs; else delete data.inputs;
    next = JSON.stringify(data, null, 2) + "\n";
  }
  validateDefinition(parseDefinitionText(next, path), registry); // never write an invalid workflow
  await writeAtomic(path, next);
}

export function createWorkflowsAdapter(deps: WorkflowResourceDeps): ResourceAdapter {
  const discovered = async () => discoverWorkflows(deps.cwd, deps.userDir ? { userDir: deps.userDir } : {});
  const item = async (found: DiscoveredWorkflow, runs: WorkflowRun[]): Promise<ResourceItem> => {
    try {
      const definition = await loadDefinition(found.path, deps.registry);
      const last = runs.find((run) => run.definition.name === definition.name);
      let nodeCount = 0;
      walkNodes(definition, () => { nodeCount++; });
      return {
        id: found.name,
        title: `${found.name}  [${found.origin}]`,
        description: [definition.description, `${nodeCount} node${nodeCount === 1 ? "" : "s"}`, last ? `last run ${statusGlyph(last.status)} ${age(last.createdAt)}` : undefined].filter(Boolean).join(" · "),
        detail: formatDefinitionDetail(found, definition, runs),
        searchText: `${definition.name} ${found.path}`,
        values: definitionValues(definition),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: found.name, title: `${found.name}  [${found.origin}] (invalid)`, description: message, detail: `${found.name}  [${found.origin}]\nSource: ${found.path}\n\nInvalid workflow: ${message}`, searchText: found.path };
    }
  };
  const list = async () => {
    const runs = await listRuns(deps.store, deps.registry).catch(() => []);
    return Promise.all((await discovered()).map((found) => item(found, runs)));
  };
  return {
    title: "Workflows",
    list,
    get: async (id) => {
      const found = (await discovered()).find((entry) => entry.name === id);
      return found ? item(found, await listRuns(deps.store, deps.registry).catch(() => [])) : undefined;
    },
    fields: WORKFLOW_EDIT_FIELDS,
    update: async (id, values) => {
      const found = (await discovered()).find((entry) => entry.name === id);
      if (!found) throw new Error("Workflow no longer exists.");
      await updateDefinitionFields(found.path, values, deps.registry);
    },
    notice: "Edit (e) changes name, description and inputs only.",
  };
}

export async function validateWorkflow(deps: WorkflowResourceDeps, name: string): Promise<string> {
  const found = (await discoverWorkflows(deps.cwd, deps.userDir ? { userDir: deps.userDir } : {})).find((entry) => entry.name === name);
  if (!found) throw new Error(`Workflow not found: ${name}`);
  await loadDefinition(found.path, deps.registry);
  return `Workflow ${name} is valid.`;
}

export async function loadWorkflow(deps: WorkflowResourceDeps, name: string): Promise<WorkflowDefinition> {
  const found = (await discoverWorkflows(deps.cwd, deps.userDir ? { userDir: deps.userDir } : {})).find((entry) => entry.name === name);
  if (!found) throw new Error(`Workflow not found: ${name}`);
  return loadDefinition(found.path, deps.registry);
}

/** Form fields for a definition's typed inputs (none for an untyped definition). */
export function inputFields(definition: WorkflowDefinition): Array<ResourceField & { type: WorkflowInputSpec["type"]; hint: string }> {
  return Object.entries(definition.inputs ?? {}).map(([name, spec]) => ({
    name,
    label: name,
    type: spec.type,
    required: spec.required === true,
    hint: [spec.type, spec.required ? "required" : spec.default !== undefined ? `default ${JSON.stringify(spec.default)}` : "optional", spec.description].filter(Boolean).join(" · "),
  }));
}

/** Converts form text to typed inputs; empty optional fields are omitted so defaults apply. */
export function parseInputValues(definition: WorkflowDefinition, values: Record<string, string>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(definition.inputs ?? {})) {
    const raw = values[name] ?? "";
    if (raw.trim() === "") {
      if (spec.required) throw new Error(`${name} is required.`);
      continue;
    }
    if (spec.type === "string") inputs[name] = raw;
    else if (spec.type === "number") {
      const value = Number(raw.trim());
      if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
      inputs[name] = value;
    } else if (spec.type === "boolean") {
      if (!/^(true|false)$/i.test(raw.trim())) throw new Error(`${name} must be true or false.`);
      inputs[name] = raw.trim().toLowerCase() === "true";
    } else {
      try { inputs[name] = JSON.parse(raw); } catch { throw new Error(`${name} must be JSON (${spec.type}).`); }
    }
  }
  return inputs;
}

// ── Launch / control actions ─────────────────────────────────────────────────

/** Config or the caller's process policy (captured in `deps.sandboxRequired`); a launch can only strengthen a run. */
function effectiveSandboxRequired(deps: WorkflowResourceDeps): boolean {
  return deps.sandboxRequired === true || deps.config.sandboxRequired === true;
}

async function launchDeps(deps: WorkflowResourceDeps): Promise<LaunchDeps & { registry: ToolRegistry }> {
  return { coordinator: await deps.getCoordinator(), cliPath: await deps.cliPath(), maxConcurrentWorkflowRuns: deps.config.maxConcurrentWorkflowRuns, registry: deps.registry, sandboxRequired: effectiveSandboxRequired(deps) };
}

/** Validates inputs and checks the host before the consent prompt; nothing is persisted. */
export async function prepareWorkflowLaunch(deps: WorkflowResourceDeps, definition: WorkflowDefinition, inputs: Record<string, unknown>, envNames: string[]): Promise<PreparedLaunch> {
  const prepared = await prepareLaunch(definition, inputs, definition.name, deps.config, envNames);
  await assertBackgroundRunsAvailable(await deps.getCoordinator());
  return prepared;
}

/** Creates the consented background run and launches its runner; returns the new run id and a summary. */
export async function startWorkflowRun(deps: WorkflowResourceDeps, prepared: PreparedLaunch, envNames: string[]): Promise<{ runId: string; message: string }> {
  const result = await startBackgroundRun(deps.store, prepared, deps.config.permissionMode, envNames, await launchDeps(deps));
  return { runId: result.run.id, message: launchSummary(result, "/workflows") };
}

export async function cancelWorkflowRun(deps: WorkflowResourceDeps, runId: string): Promise<string> {
  const run = await deps.store.read(runId, deps.registry);
  const result = await cancelRun(deps.store, runId, deps.registry, undefined, cancelJobDeps(run, deps.getCoordinator, effectiveSandboxRequired(deps), deps.config.permissionMode));
  return `Workflow run ${shortId(result.id)}: ${result.status}`;
}

export async function resumeWorkflowRun(deps: WorkflowResourceDeps, runId: string): Promise<string> {
  return launchSummary(await launchRun(deps.store, runId, await launchDeps(deps)), "/workflows");
}

export async function decideWorkflowDecision(deps: WorkflowResourceDeps, runId: string, decisionId: string, approve: boolean): Promise<string> {
  return decisionSummary(await decideRunDecision(deps.store, runId, decisionId, approve, { registry: deps.registry, launch: await launchDeps(deps) }));
}

/** Removes a settled run's checkpoint, cancel marker and run directory (events, decisions, artifacts). */
export async function deleteWorkflowRun(store: WorkflowStore, registry: ToolRegistry, runId: string): Promise<void> {
  await store.lock(runId, async () => {
    const run = await store.read(runId, registry);
    if (!isTerminalRunStatus(run.status)) throw new Error(`Run ${shortId(runId)} is ${run.status}; cancel it before deleting.`);
    const base = store.runDir(runId);
    await fs.rm(`${base}.json`, { force: true });
    await fs.rm(`${base}.cancel`, { force: true });
    await fs.rm(base, { recursive: true, force: true });
  });
}

// ── Runs ─────────────────────────────────────────────────────────────────────

function nodeProgress(run: WorkflowRun): string {
  const visits = scopedCheckpoints(run).filter((visit) => visit.loops.length === 0);
  const done = visits.filter((visit) => visit.cp.status === "passed" || visit.cp.status === "skipped").length;
  return `${done}/${visits.length} nodes`;
}

function runDescription(run: WorkflowRun, pending: PendingDecision[]): string {
  const created = Date.parse(run.createdAt);
  const time = isTerminalRunStatus(run.status) ? formatDuration(Date.parse(run.updatedAt) - created) : `started ${age(run.createdAt)}`;
  const waiting = pending.length ? ` · ◐ waiting: ${pending.map((p) => p.nodeId).join(", ")}` : "";
  return `${run.status} · ${time} · ${nodeProgress(run)}${waiting}`;
}

function runItem(run: WorkflowRun, pending: PendingDecision[]): ResourceItem {
  const first = pending[0];
  return {
    id: run.id,
    title: `${statusGlyph(run.status)} ${shortId(run.id)} ${run.definition.name}`,
    description: runDescription(run, pending),
    detail: formatRunTree(run),
    searchText: `${run.id} ${run.status} ${run.definition.name}`,
    stoppable: !isTerminalRunStatus(run.status),
    removable: isTerminalRunStatus(run.status),
    // Action metadata for the TUI (runs have no edit form).
    values: { status: run.status, workflow: run.definition.name, pendingCount: String(pending.length), ...(first ? { decisionId: first.decisionId, decisionNode: first.nodeId, decisionKind: first.kind } : {}) },
  };
}

function groupPending(pending: PendingDecision[]): Map<string, PendingDecision[]> {
  const byRun = new Map<string, PendingDecision[]>();
  for (const decision of pending) byRun.set(decision.runId, [...(byRun.get(decision.runId) ?? []), decision]);
  return byRun;
}

export async function formatRunDetail(store: WorkflowStore, run: WorkflowRun, pending: PendingDecision[] = []): Promise<string> {
  const inputs = Object.entries(run.inputs).map(([key, value]) => `${key}=${truncateOutput(value, 60)}`).join("  ");
  const events = (await readEvents(store, run.id).catch(() => [])).slice(-EVENT_TAIL);
  return [
    formatRunTree(run),
    `inputs: ${inputs || "(none)"}   cwd: ${run.cwd}${run.runner ? `   attempt ${run.runner.attempt}` : ""}`,
    ...(pending.length ? ["", "Pending decisions (a: approve, D: deny the first):", ...pending.map((p) => `  ◐ ${p.nodeId}  ${p.kind}  ${p.decisionId}  ${truncateOutput(p.summary, 100)}`)] : []),
    "",
    events.length ? "last events:" : "No events yet.",
    ...events.map(formatEvent),
  ].join("\n");
}

/** Full event trace plus every node output (hydrated from artifacts), for the `l` Logs view. */
export async function formatRunLogs(store: WorkflowStore, registry: ToolRegistry, runId: string): Promise<string> {
  const run = await store.read(runId, registry);
  const events = await readEvents(store, runId).catch(() => []);
  const lines = [`Logs for ${run.definition.name} ${run.id}`, "", `── events (${Math.min(events.length, LOG_EVENTS)} of ${events.length}) ──`, ...(events.length ? events.slice(-LOG_EVENTS).map(formatEvent) : ["(none)"])];
  for (const visit of scopedCheckpoints(run)) {
    const { cp } = visit;
    if (cp.output === undefined && !cp.error) continue;
    const scope = visit.loops.map(({ cp: loop, iteration }) => `${loop.id}#${iteration.index + 1}`).join("/");
    lines.push("", `── ${scope ? `${scope}/` : ""}${cp.id} (${cp.status}) ──`);
    if (cp.error) lines.push(`error: ${cp.error}`);
    if (cp.output !== undefined) {
      let output: unknown = cp.output;
      output = await store.readOutput(run.id, cp, visitJobScope(visit)).catch(() => cp.output);
      const text = typeof output === "string" ? output : JSON.stringify(output, null, 2) ?? String(output);
      lines.push(text.length > LOG_OUTPUT_CHARS ? `${text.slice(0, LOG_OUTPUT_CHARS)}\n… (${text.length - LOG_OUTPUT_CHARS} more characters)` : text);
    }
  }
  return lines.join("\n");
}

export function createRunsAdapter(deps: Pick<WorkflowResourceDeps, "store" | "registry">): ResourceAdapter {
  return {
    title: "Workflow runs",
    inspectLabel: "Live detail",
    list: async () => {
      const [runs, pending] = await Promise.all([listRuns(deps.store, deps.registry), listPendingDecisions(deps.store).catch(() => [])]);
      const byRun = groupPending(pending);
      // A settled run cannot be decided any more; its leftover requests are not offered.
      return runs.map((run) => runItem(run, isTerminalRunStatus(run.status) ? [] : byRun.get(run.id) ?? []));
    },
    get: async (id) => {
      const run = await deps.store.read(id, deps.registry).catch(() => undefined);
      if (!run) return undefined;
      const pending = isTerminalRunStatus(run.status) ? [] : await listPendingDecisions(deps.store, id).catch(() => []);
      return { ...runItem(run, pending), detail: await formatRunDetail(deps.store, run, pending) };
    },
    removeLabel: "Delete",
    removedLabel: "Deleted",
    removeConfirm: "This permanently removes the run's checkpoint, events, decisions and artifacts.",
    remove: (id) => deleteWorkflowRun(deps.store, deps.registry, id),
  };
}

// ── Inbox ────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = { approval: "approval", tool_consent: "tool consent", agent_tool_consent: "agent tool consent", job_start: "job start", uncertain_tool: "uncertain tool" };

export function inboxItemId(decision: Pick<PendingDecision, "runId" | "decisionId">): string { return `${decision.runId}/${decision.decisionId}`; }
export function parseInboxItemId(id: string): { runId: string; decisionId: string } {
  const [runId = "", decisionId = ""] = id.split("/");
  return { runId, decisionId };
}

/** The confirmation/detail lines for a decision: the full prompt and the full resolved tool input. */
export function decisionDetailLines(decision: PendingDecision, run?: WorkflowRun): string[] {
  const iteration = decision.iteration?.length ? ` (iteration ${decision.iteration.map((i) => i + 1).join(".")})` : "";
  const lines = [
    `${KIND_LABELS[decision.kind] ?? decision.kind} on ${decision.nodeId}${iteration}`,
    `Run: ${run ? `${run.definition.name} ` : ""}${decision.runId}`,
    ...(run ? [`Directory: ${run.cwd}`, `Permission mode: ${run.consent?.permissionMode ?? "(no consent)"}`] : []),
    `Decision: ${decision.decisionId} · requested ${decision.createdAt}`,
    "",
    decision.summary,
  ];
  if (decision.resolved) {
    lines.push("", `Tool: ${decision.resolved.toolName}  (input #${decision.resolved.inputHash.slice(0, 12)})`, ...(JSON.stringify(decision.resolved.input, null, 2) ?? "undefined").split("\n"));
  }
  lines.push("", decision.kind === "approval" ? "Approval grants no tool permissions." : "Approving allows identical calls (same tool and resolved input) of this node for the rest of the run.");
  return lines;
}

const CONFIRM_NOUNS: Record<string, string> = { approval: "approval", tool_consent: "tool call", agent_tool_consent: "tool call", job_start: "job start", uncertain_tool: "uncertain tool" };

/**
 * The short approve/deny confirmation: the action as a question, the prompt, the workflow + short run id and, for
 * tool decisions, the tool call. The full detail (directory, mode, decision id, input) stays in `decisionDetailLines`.
 */
export function decisionConfirmLines(decision: PendingDecision, run: WorkflowRun | undefined, approve: boolean): string[] {
  const iteration = decision.iteration?.length ? `#${decision.iteration.map((i) => i + 1).join(".")}` : "";
  const lines = [
    `${approve ? "Approve" : "Deny"} this ${CONFIRM_NOUNS[decision.kind] ?? decision.kind}?`,
    truncateOutput(decision.summary, 100),
    `Run: ${run ? `${run.definition.name} ` : ""}${shortId(decision.runId)} · node ${decision.nodeId}${iteration}`,
  ];
  if (decision.resolved) lines.push(`Tool call: ${decision.resolved.toolName} ${truncateOutput(decision.resolved.input, 80)}`);
  else if (decision.kind === "approval") lines.push("This does not grant tool permissions.");
  return lines;
}

export function createInboxAdapter(deps: Pick<WorkflowResourceDeps, "store" | "registry">): ResourceAdapter {
  const runCache = async (ids: string[]) => {
    const runs = new Map<string, WorkflowRun>();
    for (const id of new Set(ids)) {
      const run = await deps.store.read(id, deps.registry).catch(() => undefined);
      if (run) runs.set(id, run);
    }
    return runs;
  };
  const item = (decision: PendingDecision, run?: WorkflowRun): ResourceItem => ({
    id: inboxItemId(decision),
    title: `◐ ${decision.nodeId} · ${run?.definition.name ?? "?"} ${shortId(decision.runId)}`,
    description: `${KIND_LABELS[decision.kind] ?? decision.kind} · ${age(decision.createdAt)} · ${truncateOutput(decision.summary, 100)}`,
    detail: decisionDetailLines(decision, run).join("\n"),
    searchText: `${decision.runId} ${decision.decisionId} ${decision.kind} ${decision.resolved?.toolName ?? ""}`,
    values: { runId: decision.runId, decisionId: decision.decisionId, nodeId: decision.nodeId, kind: decision.kind },
  });
  const list = async () => {
    const pending = await listPendingDecisions(deps.store);
    const runs = await runCache(pending.map((p) => p.runId));
    // Leftover requests of settled (or unreadable) runs cannot be decided.
    return pending.filter((p) => { const run = runs.get(p.runId); return run && !isTerminalRunStatus(run.status); }).map((p) => item(p, runs.get(p.runId)));
  };
  return {
    title: "Workflow inbox",
    list,
    get: async (id) => {
      const { runId } = parseInboxItemId(id);
      const pending = (await listPendingDecisions(deps.store, runId).catch(() => [])).find((p) => inboxItemId(p) === id);
      const run = (await runCache([runId])).get(runId);
      return pending && run && !isTerminalRunStatus(run.status) ? item(pending, run) : undefined;
    },
  };
}

export async function pendingDecisionFor(store: WorkflowStore, runId: string, decisionId: string): Promise<PendingDecision | undefined> {
  return (await listPendingDecisions(store, runId).catch(() => [])).find((p) => p.decisionId === decisionId);
}

// ── Status bar badge ─────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(["running", "queued", "cancelling"]);

/**
 * Cheap activity counts for the status bar: run statuses are read from the raw checkpoint JSON (no definition
 * validation), and the approvals are the pending inbox decisions.
 */
export async function workflowActivity(store: WorkflowStore): Promise<{ running: number; needApproval: number }> {
  let running = 0;
  const open = new Set<string>();
  for (const id of await store.listIds()) {
    try {
      const status = (JSON.parse(await fs.readFile(`${store.runDir(id)}.json`, "utf8")) as { status?: string }).status;
      if (status && ACTIVE_STATUSES.has(status)) running++;
      if (status && !isTerminalRunStatus(status)) open.add(id);
    } catch { /* unreadable checkpoint */ }
  }
  let needApproval = 0;
  for (const id of open) needApproval += (await listPendingDecisions(store, id).catch(() => [])).length;
  return { running, needApproval };
}

export function workflowBadge(activity: { running: number; needApproval: number }): string | undefined {
  const parts = [activity.running ? `${activity.running} running` : "", activity.needApproval ? `${activity.needApproval} need approval` : ""].filter(Boolean);
  return parts.length ? `workflows: ${parts.join(" · ")}` : undefined;
}
