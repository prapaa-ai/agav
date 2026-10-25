import type { SlashCommand } from "./types.js";
import { createBuiltinToolRegistry } from "../tools/registry-factory.js";
import { WORKFLOW_TOOLS, loadDefinition } from "../workflows/definition.js";
import { resolveWorkflow } from "../workflows/discovery.js";
import { cancelRun, decideRunDecision, decisionSummary, resolveDecisionTarget } from "../workflows/control.js";
import { launchRun } from "../workflows/launch.js";
import { WorkflowStore } from "../workflows/store.js";
import { consentEnvNames } from "../workflows/consent-prompt.js";
import {
  assertBackgroundRunsAvailable, cancelJobDeps, cliEntryPath, inboxLines, launchSummary, listRuns, prepareLaunch,
  reconcileQuietly, startBackgroundRun,
} from "../workflows/background.js";
import { formatRunSummary, formatRunTree, resolveRunId } from "../workflows/format.js";
import { getSharedCoordinator } from "../background-jobs-integration.js";
import { isSandboxRequired } from "../utils/sandbox.js";
import { openResourceManager } from "./resource-manager.js";

const USAGE = `Usage: /workflows [<action>]   (no action opens the Workflows TUI: Workflows · Runs · Inbox)
  validate <name|file>
  run <name|file> [--input-json {"key":"value"}]
  list
  status <run-id>
  inbox [<run-id>]
  approve|deny <run-id> <node-id|decision-id> [--note <text>]
  resume|cancel <run-id>

<run-id> is the full UUID or any unique prefix of at least 4 characters.
Runs execute in the background and outlive this session; run returns immediately after you
approve its consent (capabilities and which environment variable names reach the runner).
Both backgroundJobsEnabled and workflowsEnabled must be true.
A bare name is looked up in ./.agav/workflows then ~/.agav/workflows (JSON or YAML).
Paths may be double-quoted. Input JSON is the remainder after --input-json (no shell quotes).
A run needing a decision parks and is listed by inbox; approve/deny resumes it automatically.
Approval nodes never grant tool permission; tool consent is a separate decision.`;

/**
 * Deliberately not a shell parser: keep JSON strings and whitespace intact. A double-quoted target
 * is JSON-decoded (may throw). Shared with the app's active-run `/workflows cancel` interception.
 */
export function parseWorkflowsArgs(args: string): { action: string; target: string; rest: string } | undefined {
  if (args.trim() === "list") return { action: "list", target: "", rest: "" };
  if (args.trim() === "inbox") return { action: "inbox", target: "", rest: "" };
  if (/^inbox\s/.test(args.trim())) {
    const target = args.trim().slice("inbox".length).trim();
    return /^\S+$/.test(target) ? { action: "inbox", target, rest: "" } : undefined;
  }
  const match = /^(validate|run|status|approve|deny|resume|cancel)\s+("(?:[^"\\]|\\.)*"|\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!match) return undefined;
  const target: string = match[2]!.startsWith('"') ? JSON.parse(match[2]!) : match[2]!;
  return { action: match[1]!, target, rest: match[3] ?? "" };
}

export const workflowsCommand: SlashCommand = {
  name: "workflows",
  description: "Validate, run (in the background) and control JSON/YAML workflows (opt-in)",
  usage: USAGE,
  async execute(args, context) {
    const message = (text: string) => ({ type: "message" as const, text });
    if (context.config.backgroundJobsEnabled !== true || context.config.workflowsEnabled !== true) return message("Workflows require backgroundJobsEnabled=true AND workflowsEnabled=true.");
    if (!args.trim()) {
      // Interactive sessions open the Workflows TUI; scripts keep the text usage.
      const interactive = openResourceManager("workflows", context);
      if (interactive) return interactive;
      return message(USAGE);
    }
    if (["help", "--help", "-h"].includes(args.trim())) return message(USAGE);
    try {
      const parsed = parseWorkflowsArgs(args);
      if (!parsed) throw new Error(USAGE);
      const { action, rest } = parsed;
      let { target } = parsed;
      const decision = action === "approve" || action === "deny";
      if (action === "run" ? rest && !rest.startsWith("--input-json ") : decision ? !/^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\s+--note\s+\S[\s\S]*)?$/.test(rest) : rest !== "") throw new Error(USAGE);
      const registry = createBuiltinToolRegistry(WORKFLOW_TOOLS);
      const store = new WorkflowStore();
      // Every run-id operand accepts a unique prefix (≥4 chars) or the full UUID (U4).
      if (target && action !== "validate" && action !== "run") target = await resolveRunId(store, target);
      const sandboxRequired = context.config.sandboxRequired === true || isSandboxRequired();
      const launchDeps = async () => ({ coordinator: await getSharedCoordinator(), cliPath: await cliEntryPath(), maxConcurrentWorkflowRuns: context.config.maxConcurrentWorkflowRuns, registry, sandboxRequired });
      const warnings: string[] = [];
      const warn = (text: string): void => { warnings.push(`warning: ${text}`); };
      if (action === "validate") { await loadDefinition((await resolveWorkflow(target, process.cwd())).path, registry); return message("Workflow valid."); }
      if (action === "list" || action === "status") {
        await reconcileQuietly(store, action === "status" ? target : undefined, await launchDeps(), warn);
        const text = action === "status" ? formatRunTree(await store.read(target, registry)) : (await listRuns(store, registry)).map(run => formatRunSummary(run)).join("\n") || "No workflow runs.";
        return message([...warnings, text].join("\n"));
      }
      if (action === "inbox") return message((await inboxLines(store, target || undefined)).join("\n") || "No pending workflow decisions.");
      if (decision) {
        const [, item, note] = /^(\S+)(?:\s+--note\s+([\s\S]+))?$/.exec(rest)!;
        const pending = await resolveDecisionTarget(store, target, item!);
        return message(decisionSummary(await decideRunDecision(store, target, pending.decisionId, action === "approve", { registry, note: note?.trim(), launch: await launchDeps() })));
      }
      if (action === "cancel") {
        const run = await cancelRun(store, target, registry, undefined, cancelJobDeps(await store.read(target, registry), getSharedCoordinator, sandboxRequired, context.config.permissionMode));
        return message(`Workflow run ${run.id}: ${run.status}`);
      }
      if (action === "resume") return message(launchSummary(await launchRun(store, target, await launchDeps()), "/workflows"));

      // run: background only, consent asked on every invocation.
      if (!context.requestWorkflowConsent) throw new Error("Workflow runs need interactive consent; use agav workflows run in a terminal.");
      const inputs: unknown = rest ? JSON.parse(rest.slice("--input-json ".length)) : {};
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("--input-json must be a JSON object.");
      const resolved = await resolveWorkflow(target, process.cwd());
      const prepared = await prepareLaunch(await loadDefinition(resolved.path, registry), inputs as Record<string, unknown>, resolved.name, context.config, consentEnvNames());
      const deps = await launchDeps();
      await assertBackgroundRunsAvailable(deps.coordinator);
      const envNames = await context.requestWorkflowConsent(prepared.request);
      if (!envNames) return message("Workflow run not approved.");
      return message(launchSummary(await startBackgroundRun(store, prepared, context.config.permissionMode, envNames, deps), "/workflows"));
    } catch (error) {
      return message(`Workflow error: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
