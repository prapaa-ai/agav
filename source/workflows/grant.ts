import type { PermissionMode } from "../config/config.js";
import type { GrantAction, SessionPolicySnapshot } from "../background-jobs/types.js";
import { clampPermissionMode } from "../config/org-config.js";
import { walkNodes, type WorkflowDefinition, type WorkflowNode } from "./definition.js";
import { definitionHash } from "./store.js";

/**
 * Per-invocation consent for a background run, stored on the run (`run.consent`) and reused by its relaunches.
 * Capabilities are derived statically from the definition; only environment variable NAMES are recorded.
 */
export interface WorkflowConsent {
  definitionHash: string;
  cwd: string;
  permissionMode: PermissionMode;
  capabilities: { tools: string[]; jobCommands: string[] };
  envNames: string[];
  grantedAt: string;
}

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PERMISSION_MODES = new Set<string>(["ask", "auto-accept", "deny-writes"]);

function uniqueSorted(values: string[]): string[] { return [...new Set(values)].sort(); }

/** Builds the consent record for one launch; rejects anything that is not a plain env var name (never a value). */
export function buildConsent(definition: WorkflowDefinition, cwd: string, permissionMode: PermissionMode, envNames: string[]): WorkflowConsent {
  for (const name of envNames) if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) throw new Error(`Invalid environment variable name for workflow consent: ${JSON.stringify(name)}`);
  // Loop bodies included: their tools and job commands run under the same consent.
  const nodes: WorkflowNode[] = [];
  walkNodes(definition, node => { nodes.push(node); });
  return {
    definitionHash: definitionHash(definition),
    cwd,
    permissionMode,
    capabilities: {
      tools: uniqueSorted(nodes.filter(node => node.type === "tool" && node.tool).map(node => node.tool!)),
      jobCommands: uniqueSorted(nodes.filter(node => node.type === "job" && node.command !== undefined).map(node => node.command!)),
    },
    envNames: uniqueSorted(envNames),
    grantedAt: new Date().toISOString(),
  };
}

/** Job commands are literal, so coverage is an exact match. */
export function consentCoversJob(consent: WorkflowConsent, command: string): boolean { return consent.capabilities.jobCommands.includes(command); }
export function consentCoversTool(consent: WorkflowConsent, name: string): boolean { return consent.capabilities.tools.includes(name); }

/** The consent's mode after the org floor: a stored consent can never run looser than the managed floor of the process executing it. */
export function effectivePermissionMode(consent: WorkflowConsent, floor?: PermissionMode): PermissionMode { return clampPermissionMode(consent.permissionMode, floor); }

/**
 * The consent as honored under `floor`. When the floor tightens the stored mode, the approval it recorded (given
 * under the looser mode) no longer stands in for a prompt: nothing is covered, so tool calls ask (park on a
 * decision) and job starts are refused. Unchanged when the floor does not tighten it.
 */
export function clampConsent(consent: WorkflowConsent, floor?: PermissionMode): WorkflowConsent {
  const permissionMode = effectivePermissionMode(consent, floor);
  return permissionMode === consent.permissionMode ? consent : { ...consent, permissionMode, capabilities: { tools: [], jobCommands: [] } };
}

/**
 * Headless session for work the consent covers. The headless gate stays explicit (`actions`), deny-writes is kept,
 * and otherwise the interactive per-invocation consent stands in for the prompt no detached process can show.
 * Callers must only hand this to requests the consent covers (the runner launch, literal job commands).
 * Under an org `floor` that tightens the stored mode the stored approval is void: `start` is dropped from the
 * approved actions (only `stop` remains so cleanup and cancellation still work) and deny-writes is applied.
 */
export function consentSession(consent: WorkflowConsent, actions: GrantAction[], signal?: AbortSignal, floor?: PermissionMode): SessionPolicySnapshot {
  const effective = effectivePermissionMode(consent, floor);
  const approved = effective === consent.permissionMode ? actions : actions.filter(action => action !== "start");
  return { permissionMode: effective === "deny-writes" ? "deny-writes" : "auto-accept", headlessApprovedActions: [...approved], ...(signal ? { signal } : {}) };
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
/** Shape check used by `store.read`; binding to the run's hash/cwd is checked there. */
export function isWorkflowConsent(value: unknown): value is WorkflowConsent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { definitionHash: hash, cwd, permissionMode, capabilities, envNames, grantedAt, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length !== 0 || typeof hash !== "string" || typeof cwd !== "string" || typeof permissionMode !== "string" || !PERMISSION_MODES.has(permissionMode) || typeof grantedAt !== "string") return false;
  if (!stringArray(envNames) || !envNames.every(name => ENV_NAME_PATTERN.test(name))) return false;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const { tools, jobCommands, ...capExtra } = capabilities as Record<string, unknown>;
  return Object.keys(capExtra).length === 0 && stringArray(tools) && stringArray(jobCommands);
}
