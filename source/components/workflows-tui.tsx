import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "../ink/index.js";
import { ResourceManager, type ResourceAction } from "./resource-manager.js";
import WorkflowConsent from "./workflow-consent.js";
import type { AgavConfig } from "../config/config.js";
import type { ClipboardNotice } from "../ink/termio/clipboard.js";
import type { ResourceItem } from "../resources/types.js";
import {
  cancelWorkflowRun, createInboxAdapter, createRunsAdapter, createWorkflowsAdapter, decideWorkflowDecision, decisionConfirmLines,
  formatRunLogs, inputFields, loadWorkflow, parseInputValues, pendingDecisionFor, prepareWorkflowLaunch, resumeWorkflowRun,
  startWorkflowRun, validateWorkflow, workflowActivity, type WorkflowResourceDeps,
} from "../resources/workflow-adapters.js";
import type { PreparedLaunch } from "../workflows/background.js";
import { consentEnvNames } from "../workflows/consent-prompt.js";
import type { WorkflowDefinition } from "../workflows/definition.js";
import { shortId } from "../workflows/format.js";
import { cliEntryPath } from "../workflows/background.js";
import { WORKFLOW_TOOLS } from "../workflows/definition.js";
import { WorkflowStore } from "../workflows/store.js";
import { createBuiltinToolRegistry } from "../tools/registry-factory.js";
import { getSharedCoordinator, reconcileWorkflowRunsNow, type WorkflowReconcileOptions } from "../background-jobs-integration.js";
import { isSandboxRequired } from "../utils/sandbox.js";

/** The app's real dependencies: the shared coordinator, the user's run store and the cwd's workflows. */
export function defaultWorkflowResourceDeps(config: WorkflowsTUIProps["config"]): WorkflowResourceDeps {
  return {
    store: new WorkflowStore(),
    registry: createBuiltinToolRegistry(WORKFLOW_TOOLS),
    cwd: process.cwd(),
    config,
    getCoordinator: getSharedCoordinator,
    cliPath: () => cliEntryPath(),
    sandboxRequired: isSandboxRequired(),
  };
}

export const WORKFLOW_TABS = ["workflows", "runs", "inbox"] as const;
export type WorkflowTab = typeof WORKFLOW_TABS[number];
const TAB_LABELS: Record<WorkflowTab, string> = { workflows: "Workflows", runs: "Runs", inbox: "Inbox" };
/** Footer for a confirmation that names the chosen action, so `n/ESC` never reads as the action itself. */
export function confirmControls(yes: string, no = "Go back"): string { return `y: Yes, ${yes} · n/ESC: ${no}`; }
const RUN_REFRESH_MS = 1000;
const BADGE_POLL_MS = 5000;
const RESUMABLE = new Set(["interrupted", "waiting_approval", "queued", "pending"]);

export interface WorkflowsTUIProps {
  onExit(): void;
  config: Pick<AgavConfig, "permissionMode" | "maxConcurrentWorkflowRuns">;
  /** Height available for the overlay within the app footer. */
  height?: number;
  copyNotice?: ClipboardNotice | null;
  /** Store, registry, coordinator and paths (tests pass fakes); defaults to the app's real ones. */
  deps?: WorkflowResourceDeps;
  initialTab?: WorkflowTab;
  /**
   * Reconcile/admission pass fired (best effort, non-blocking) when the TUI opens. Defaults to
   * `reconcileWorkflowRunsNow` with the real deps; skipped when fake `deps` are passed without one (tests).
   */
  reconcileRuns?: (opts: WorkflowReconcileOptions) => Promise<void>;
}

interface PendingConfirmation {
  prompt: string;
  lines: string[];
  controls: string;
  resolve(ok: boolean): void;
}

/** Input form for a run's typed inputs (before consent). */
interface InputStage { kind: "inputs"; definition: WorkflowDefinition; values: Record<string, string>; field: number; error?: string }
/** Per-invocation consent with the env checklist (reuses the Phase 1 component). */
interface ConsentStage { kind: "consent"; prepared: PreparedLaunch }
type Stage = InputStage | ConsentStage;

function InputForm({ stage, onChange, onSubmit, onCancel }: {
  stage: InputStage;
  onChange(stage: InputStage): void;
  onSubmit(stage: InputStage): void;
  onCancel(): void;
}) {
  const fields = inputFields(stage.definition);
  const field = fields[stage.field];
  const append = (text: string) => { if (field) onChange({ ...stage, error: undefined, values: { ...stage.values, [field.name]: (stage.values[field.name] ?? "") + text } }); };
  usePaste(append);
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { onSubmit(stage); return; }
    if (key.tab || key.downArrow) { onChange({ ...stage, field: (stage.field + 1) % fields.length }); return; }
    if (key.upArrow) { onChange({ ...stage, field: (stage.field + fields.length - 1) % fields.length }); return; }
    if ((key.backspace || key.delete) && field) onChange({ ...stage, error: undefined, values: { ...stage.values, [field.name]: (stage.values[field.name] ?? "").slice(0, -1) } });
    else if (input && !key.ctrl && !key.meta) append(input);
  });
  return <Box flexDirection="column">
    <Text bold color="cyan">Run {stage.definition.name} · Inputs</Text>
    {fields.map((f, i) => <Box key={f.name} flexDirection="column">
      <Text color={i === stage.field ? "cyan" : undefined}>{i === stage.field ? "→ " : "  "}{f.label}: {stage.values[f.name] ?? ""}{i === stage.field ? "█" : ""}</Text>
      <Text dimColor>    {f.hint}</Text>
    </Box>)}
    {stage.error && <Text color="yellow">{stage.error}</Text>}
    <Text dimColor>Tab/↑↓: Field | ENTER: Continue to consent | ESC: Cancel</Text>
  </Box>;
}

export function WorkflowsTUI({ onExit, config, deps: provided, initialTab = "workflows", reconcileRuns, height: availableHeight, copyNotice }: WorkflowsTUIProps) {
  // Stable across parent renders so adapters (and their refresh timers) are not recreated.
  const deps = useMemo(() => provided ?? defaultWorkflowResourceDeps(config), [provided, config.permissionMode, config.maxConcurrentWorkflowRuns]);
  const [tab, setTab] = useState<WorkflowTab>(initialTab);
  const [stage, setStage] = useState<Stage | null>(null);
  const [notice, setNotice] = useState("");
  const [inboxCount, setInboxCount] = useState(0);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  pendingRef.current = pending;
  const mounted = useRef(true);
  const { stdout } = useStdout();

  const workflows = useMemo(() => createWorkflowsAdapter(deps), [deps]);
  const runs = useMemo(() => createRunsAdapter(deps), [deps]);
  const inbox = useMemo(() => createInboxAdapter(deps), [deps]);

  // On open: recover dead runners and admit queued runs into free slots. Never rejects; does not block render.
  useEffect(() => {
    const reconcile = reconcileRuns ?? (provided ? undefined : reconcileWorkflowRunsNow);
    if (!reconcile) return;
    void Promise.resolve().then(() => reconcile({ maxConcurrentWorkflowRuns: config.maxConcurrentWorkflowRuns })).catch(() => { /* best effort */ });
  }, []); // once per mount

  useEffect(() => {
    mounted.current = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { const { needApproval } = await workflowActivity(deps.store); if (mounted.current) setInboxCount(needApproval); }
      catch { /* badge is best effort */ } finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, BADGE_POLL_MS);
    return () => { mounted.current = false; clearInterval(timer); pendingRef.current?.resolve(false); pendingRef.current = null; };
  }, [deps]);

  useInput((input, key) => {
    if (!pending) return;
    const answer = input.toLowerCase();
    if (answer !== "y" && answer !== "n" && !key.escape) return;
    pendingRef.current = null;
    setPending(null);
    pending.resolve(answer === "y");
  });

  const confirm = (lines: string[], controls: string) => new Promise<boolean>((resolve) => setPending({ prompt: lines[0] ?? "", lines, controls, resolve }));

  /** Approve/deny one decision through the shared confirmation layout; returns the status text. */
  const decideWithConfirm = async (runId: string, decisionId: string, approve: boolean): Promise<string> => {
    const decision = await pendingDecisionFor(deps.store, runId, decisionId);
    if (!decision) throw new Error("That decision is no longer pending.");
    const run = await deps.store.read(runId, deps.registry).catch(() => undefined);
    const ok = await confirm(decisionConfirmLines(decision, run, approve), confirmControls(approve ? "approve" : "deny"));
    if (!ok) return "Not decided.";
    const summary = await decideWorkflowDecision(deps, runId, decisionId, approve);
    void workflowActivity(deps.store).then(({ needApproval }) => { if (mounted.current) setInboxCount(needApproval); }).catch(() => {});
    return summary;
  };

  /** Cancel one run after a short y/n confirmation; returns the status text. */
  const cancelWithConfirm = async (runId: string): Promise<string> => {
    const run = await deps.store.read(runId, deps.registry).catch(() => undefined);
    const ok = await confirm([
      "Cancel this run?",
      `Run: ${run ? `${run.definition.name} ` : ""}${shortId(runId)}`,
      "Its runner and jobs are stopped.",
    ], confirmControls("cancel run", "Keep running"));
    if (!ok) return "Not cancelled.";
    return cancelWorkflowRun(deps, runId);
  };

  /** Inputs (when typed) → consent with env checklist → background launch → Runs tab. */
  const beginRun = async (definition: WorkflowDefinition, inputs?: Record<string, unknown>): Promise<void> => {
    setNotice("");
    if (inputs === undefined && inputFields(definition).length > 0) {
      setStage({ kind: "inputs", definition, values: {}, field: 0 });
      return;
    }
    const prepared = await prepareWorkflowLaunch(deps, definition, inputs ?? {}, consentEnvNames());
    setStage({ kind: "consent", prepared });
  };

  const submitInputs = (current: InputStage) => {
    void (async () => {
      try {
        const inputs = parseInputValues(current.definition, current.values);
        const prepared = await prepareWorkflowLaunch(deps, current.definition, inputs, consentEnvNames());
        if (mounted.current) setStage({ kind: "consent", prepared });
      } catch (error) {
        if (mounted.current) setStage({ ...current, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };

  const onConsent = (prepared: PreparedLaunch, envNames: string[] | undefined) => {
    if (!envNames) { setStage(null); setNotice("Workflow run not approved."); return; }
    void (async () => {
      try {
        const { message } = await startWorkflowRun(deps, prepared, envNames);
        if (!mounted.current) return;
        // Runs are newest first, so the new run is selected on the fresh Runs list.
        setTab("runs");
        setNotice(message);
      } catch (error) {
        if (mounted.current) setNotice(`Workflow error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (mounted.current) setStage(null);
      }
    })();
  };

  const nextTab = WORKFLOW_TABS[(WORKFLOW_TABS.indexOf(tab) + 1) % WORKFLOW_TABS.length]!;
  const tabLabel = (t: WorkflowTab) => t === "inbox" && inboxCount > 0 ? `${TAB_LABELS[t]} (${inboxCount})` : TAB_LABELS[t];
  const switchTab: ResourceAction = { key: "Tab", label: tabLabel(nextTab), run: () => { setNotice(""); setTab(nextTab); } };
  type Target = Parameters<ResourceAction["run"]>[0];
  const actions: ResourceAction[] = [switchTab];
  if (tab === "workflows") actions.push(
    { key: "R", label: "Run", inDetail: true, when: (item) => !item.title.endsWith("(invalid)"), run: async (item: Target) => { if (item) await beginRun(await loadWorkflow(deps, item.id)); } },
    { key: "v", label: "Validate", inDetail: true, run: async (item: Target) => item ? validateWorkflow(deps, item.id) : undefined },
  );
  if (tab === "runs") {
    const decisionOf = (item: ResourceItem) => item.values?.decisionId;
    actions.push(
      { key: "x", label: "Cancel", inDetail: true, when: (item) => item.stoppable === true, run: async (item: Target) => item ? cancelWithConfirm(item.id) : undefined },
      { key: "a", label: "Approve", hint: "a/D: Approve/Deny", inDetail: true, when: (item) => Boolean(decisionOf(item)), run: async (item: Target) => item ? decideWithConfirm(item.id, decisionOf(item)!, true) : undefined },
      { key: "D", label: "Deny", hint: "", inDetail: true, when: (item) => Boolean(decisionOf(item)), run: async (item: Target) => item ? decideWithConfirm(item.id, decisionOf(item)!, false) : undefined },
      { key: "l", label: "Logs", run: async (item: Target) => item ? { detail: await formatRunLogs(deps.store, deps.registry, item.id) } : undefined },
      { key: "R", label: "Re-run", run: async (item: Target) => {
        if (!item) return;
        const run = await deps.store.read(item.id, deps.registry);
        await beginRun(run.definition, run.inputs);
      } },
      { key: "u", label: "Resume", inDetail: true, when: (item) => RESUMABLE.has(item.values?.status ?? ""), run: async (item: Target) => item ? resumeWorkflowRun(deps, item.id) : undefined },
    );
  }
  if (tab === "inbox") actions.push(
    { key: "a", label: "Approve", hint: "a/D: Approve/Deny", inDetail: true, run: async (item: Target) => item ? decideWithConfirm(item.values!.runId!, item.values!.decisionId!, true) : undefined },
    { key: "D", label: "Deny", hint: "", inDetail: true, run: async (item: Target) => item ? decideWithConfirm(item.values!.runId!, item.values!.decisionId!, false) : undefined },
  );

  if (stage?.kind === "inputs") return <InputForm stage={stage} onChange={setStage} onSubmit={submitInputs} onCancel={() => { setStage(null); setNotice("Run cancelled."); }} />;
  if (stage?.kind === "consent") return <WorkflowConsent request={stage.prepared.request} onDecide={(envNames) => onConsent(stage.prepared, envNames)} />;

  const extraRows = 1 + (notice ? 1 : 0) + (copyNotice ? 1 : 0);
  // The standalone TUI reserves the terminal's two edge rows, but the app-provided
  // height is already the overlay's usable area. Only budget its tab and notice rows.
  const height = availableHeight === undefined
    ? Math.max(8, (stdout.rows || 24) - 2 - extraRows)
    : Math.max(2, availableHeight - extraRows);
  return <Box flexDirection="column">
    <Text>{WORKFLOW_TABS.map((t, i) => <Text key={t} color={t === tab ? "cyan" : undefined} bold={t === tab} dimColor={t !== tab}>{i ? " │ " : ""}{tabLabel(t)}</Text>)}</Text>
    {notice && <Text color="yellow" wrap="truncate-end">{notice}</Text>}
    <ResourceManager
      key={tab}
      adapter={tab === "workflows" ? workflows : tab === "runs" ? runs : inbox}
      onExit={onExit}
      actions={actions}
      height={height}
      refreshIntervalMs={tab === "workflows" ? undefined : RUN_REFRESH_MS}
      emptyText={tab === "inbox" ? "No pending decisions." : undefined}
      prompt={pending?.prompt}
      promptDetails={pending ? { lines: pending.lines, controls: pending.controls } : undefined}
    />
    {copyNotice && <Text color={copyNotice === "Copied to clipboard" ? "green" : "cyan"}>{copyNotice === "Copied to clipboard" ? "✓ " : ""}{copyNotice}</Text>}
  </Box>;
}
