import { Ajv } from "ajv";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYAML } from "yaml";
import type { ToolRegistry } from "../tools/registry.js";
import { EFFORT_LEVELS } from "../config/config.js";
import { extractReferences } from "./interpolate.js";
import { parseExpression, referencedNodes, type ExprNode } from "./expr.js";
import { SAFE_TOOLS } from "./gated-tools.js";
import type { PermissionMode } from "../config/config.js";

export interface WorkflowNode {
  id: string;
  type: "tool" | "approval" | "job" | "agent" | "prompt" | "loop";
  dependsOn?: string[];
  tool?: string;
  /** Literal shell text for `job` nodes; no interpolation. */
  command?: string;
  input?: Record<string, unknown>;
  /** Approval gate text, or the (interpolated) task of a `prompt` node. */
  prompt?: string;
  timeoutSeconds?: number;
  /** `agent` nodes: installed agent name (resolved via loadAgents) and the interpolated task. */
  agent?: string;
  task?: string;
  model?: string;
  effort?: string;
  maxIterations?: number;
  /** Re-run an interrupted agent/prompt node on resume (default true); false parks it on an uncertain decision. */
  retrySafe?: boolean;
  output?: "text" | "json";
  outputSchema?: Record<string, unknown>;
  /** `prompt` nodes: built-in tools the synthetic agent may use (subset of WORKFLOW_TOOLS). */
  allowedTools?: string[];
  /** Condition (see expr.ts); false gives `skipped`. It may only reference dependencies. */
  when?: string;
  /** Accept `skipped` dependencies as satisfied; without it a node with a skipped dependency is skipped too (cascade). */
  allowSkipped?: boolean;
  /** Automatic retries after a failed/timed-out attempt: `max` extra attempts (total attempts = max + 1). */
  retry?: RetryPolicy;
  /**
   * A failed or timed-out outcome (after retries) does not fail the enclosing scope (run or loop iteration); dependents
   * still run and see the status (branch with `when`). Never applies to uncertain or cancelled outcomes.
   */
  continueOnError?: boolean;
  /** `loop` nodes: the body sub-DAG run once per iteration (ids are globally unique; dependsOn stays within the body). */
  body?: WorkflowNode[];
  /** `loop` nodes: stop (passed) once this expression is true after an iteration; may reference body nodes and `loop.*`. */
  until?: string;
  /** `loop` nodes: stop once body node `node` ends an iteration with `status`. */
  stopWhen?: LoopStopWhen;
  /** `loop` nodes: outcome when maxIterations is reached without a stop condition (default "fail"). */
  onExhausted?: "fail" | "continue";
  /** `loop` nodes: how many previous iteration outputs `loop.history` keeps. */
  historyLimit?: number;
}
export interface LoopStopWhen { node: string; status: "pending" | "running" | "waiting_approval" | "passed" | "failed" | "cancelled" | "timed_out" | "skipped" }
/** Hard limits for loop nodes. */
export const MAX_LOOP_ITERATIONS = 50;
export const MAX_LOOP_DEPTH = 2;
/** Fields only `loop` nodes may carry. */
const LOOP_FIELDS = ["body", "until", "stopWhen", "onExhausted", "historyLimit"] as const;
/**
 * Visits every node depth-first in definition order, including loop bodies. `path` holds the ids of the
 * enclosing loop nodes (outermost first; empty for top-level nodes).
 */
export function walkNodes(definition: { nodes: WorkflowNode[] }, visit: (node: WorkflowNode, path: string[]) => void): void {
  const walk = (nodes: WorkflowNode[], path: string[]): void => {
    for (const node of nodes) {
      visit(node, path);
      if (node.type === "loop" && Array.isArray(node.body)) walk(node.body, [...path, node.id]);
    }
  };
  walk(definition.nodes, []);
}
export interface RetryPolicy { max: number; backoffSeconds?: number }
/** Run-level policies (R3). `maxConcurrency` is stored only (scheduling is sequential until S1). */
export interface WorkflowPolicies {
  maxRuntimeSeconds?: number;
  maxConcurrency?: number;
  /** Default true. False: a failed node does not stop independent branches; its dependents are skipped. */
  stopOnFailure?: boolean;
  /** Narrows (never widens) the session/run permission mode. */
  permissionMode?: PermissionMode;
}
/** Least to most permissive. */
export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = ["deny-writes", "ask", "auto-accept"];
/** The stricter of the session mode and the workflow policy mode; a policy can never widen the session. */
export function narrowPermissionMode(session: PermissionMode, policy: PermissionMode | undefined): PermissionMode {
  if (policy === undefined) return session;
  const s = PERMISSION_MODE_ORDER.indexOf(session), p = PERMISSION_MODE_ORDER.indexOf(policy);
  // An unrecognised session mode is treated as the strictest.
  if (s < 0) return "deny-writes";
  return p >= 0 && p < s ? policy : session;
}
/** Fields only agent/prompt nodes may carry (besides `agent`/`task`/`allowedTools`, checked per type). */
const AGENT_FIELDS = ["model", "effort", "maxIterations", "retrySafe", "output", "outputSchema"] as const;
export type WorkflowInputType = "string" | "number" | "boolean" | "object" | "array";
/** Typed run input; `default` must match `type`, and a required input cannot declare a default. */
export interface WorkflowInputSpec {
  type: WorkflowInputType;
  default?: unknown;
  required?: boolean;
  description?: string;
}
export interface WorkflowDefinition {
  version: 1;
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInputSpec>;
  policies?: WorkflowPolicies;
  nodes: WorkflowNode[];
}
/** Input names are plain identifiers so `${inputs.<name>}` stays unambiguous. */
export const INPUT_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,63}$";
export const INPUT_TYPES = ["string", "number", "boolean", "object", "array"] as const;
/** True when `value` has the JSON type `type` (numbers must be finite; arrays are not objects). */
export function matchesInputType(value: unknown, type: WorkflowInputType): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
  }
}
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile({
  type: "object", additionalProperties: false, required: ["version", "name", "nodes"],
  properties: {
    version: { const: 1 }, name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string" },
    inputs: {
      type: "object", maxProperties: 100, propertyNames: { pattern: INPUT_NAME_PATTERN },
      additionalProperties: {
        type: "object", additionalProperties: false, required: ["type"],
        properties: { type: { enum: INPUT_TYPES }, default: {}, required: { type: "boolean" }, description: { type: "string" } },
      },
    },
    policies: {
      type: "object", additionalProperties: false,
      properties: {
        maxRuntimeSeconds: { type: "number", exclusiveMinimum: 0, maximum: 604800 },
        maxConcurrency: { type: "integer", minimum: 1, maximum: 64 },
        stopOnFailure: { type: "boolean" },
        permissionMode: { enum: ["ask", "auto-accept", "deny-writes"] },
      },
    },
    nodes: { type: "array", minItems: 1, maxItems: 1000, items: { $ref: "#/definitions/node" } },
  },
  definitions: {
    node: {
      type: "object", additionalProperties: false, required: ["id", "type"],
      properties: {
        id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
        type: { enum: ["tool", "approval", "job", "agent", "prompt", "loop"] },
        dependsOn: { type: "array", uniqueItems: true, items: { type: "string" } },
        tool: { type: "string" }, input: { type: "object" }, command: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 },
        timeoutSeconds: { type: "number", exclusiveMinimum: 0, maximum: 86400 },
        agent: { type: "string", minLength: 1 }, task: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 }, effort: { enum: EFFORT_LEVELS },
        maxIterations: { type: "integer", minimum: 1, maximum: 200 }, retrySafe: { type: "boolean" },
        output: { enum: ["text", "json"] }, outputSchema: { type: "object" },
        allowedTools: { type: "array", uniqueItems: true, items: { type: "string" } },
        when: { type: "string", minLength: 1, maxLength: 2000 }, allowSkipped: { type: "boolean" }, continueOnError: { type: "boolean" },
        retry: {
          type: "object", additionalProperties: false, required: ["max"],
          properties: { max: { type: "integer", minimum: 1, maximum: 10 }, backoffSeconds: { type: "number", minimum: 0, maximum: 3600 } },
        },
        body: { type: "array", minItems: 1, maxItems: 1000, items: { $ref: "#/definitions/node" } },
        until: { type: "string", minLength: 1, maxLength: 2000 },
        stopWhen: {
          type: "object", additionalProperties: false, required: ["node", "status"],
          properties: { node: { type: "string", minLength: 1 }, status: { enum: ["pending", "running", "waiting_approval", "passed", "failed", "cancelled", "timed_out", "skipped"] } },
        },
        onExhausted: { enum: ["fail", "continue"] },
        historyLimit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
  },
});

// Only built-ins whose execution/settlement and permission boundary are supported here.
export const WORKFLOW_TOOLS = ["read_file", "write_file", "edit_file", "run_command", "grep_search", "find_files", "list_directory", "overview"] as const;

export function validateDefinition(value: unknown, registry: ToolRegistry): WorkflowDefinition {
  if (!validate(value)) throw new Error(`Invalid workflow (supported nodes: tool, approval, job, agent, prompt, loop): ${ajv.errorsText(validate.errors)}`);
  const definition = value as WorkflowDefinition;
  for (const [name, spec] of Object.entries(definition.inputs ?? {})) {
    if (spec.default !== undefined && !matchesInputType(spec.default, spec.type)) throw new Error(`Input ${name}: default must be of type ${spec.type}.`);
    if (spec.required === true && spec.default !== undefined) throw new Error(`Input ${name}: a required input cannot have a default.`);
  }
  // Ids are unique across the whole definition, including loop bodies.
  const ids = new Set<string>();
  walkNodes(definition, (node, path) => {
    if (ids.has(node.id)) throw new Error(`Duplicate node: ${node.id}`);
    ids.add(node.id);
    const has = (field: keyof WorkflowNode): boolean => node[field] !== undefined;
    if (node.type !== "loop") {
      const extra = LOOP_FIELDS.find(field => has(field));
      if (extra) throw new Error(`Invalid ${node.type} node ${node.id}: ${extra} is only allowed on loop nodes.`);
    }
    if (node.type !== "agent" && node.type !== "prompt") {
      const extra = [...AGENT_FIELDS, "agent", "task", "allowedTools"].find(field => has(field as keyof WorkflowNode) && !(node.type === "loop" && field === "maxIterations"));
      if (extra) throw new Error(`Invalid ${node.type} node ${node.id}: ${extra} is only allowed on agent/prompt nodes.`);
    }
    // A loop's outcome is a container outcome (use onExhausted), and an approval denial is a human decision.
    if (node.continueOnError !== undefined && (node.type === "loop" || node.type === "approval")) throw new Error(`Invalid ${node.type} node ${node.id}: continueOnError is not supported on ${node.type} nodes.`);
    if (node.type === "loop") {
      validateLoopNode(node, path);
    } else if (node.type === "agent" || node.type === "prompt") {
      validateAgentNode(node, has);
    } else if (node.type === "approval") {
      // Approvals wait for a human indefinitely: no timeout and no automatic retry.
      if (node.timeoutSeconds !== undefined) throw new Error(`Approval nodes do not support timeoutSeconds (approvals wait until decided): ${node.id}`);
      if (node.retry !== undefined) throw new Error(`Approval nodes do not support retry: ${node.id}`);
      if (!node.prompt || node.tool !== undefined || node.input !== undefined || node.command !== undefined) throw new Error(`Invalid approval node: ${node.id}`);
    } else if (node.type === "job") {
      // Literal command only. timeoutSeconds is enforced by the runtime with an explicit stop (until supervisor maxRuntimeMs, G3).
      if (typeof node.command !== "string" || node.command.trim() === "") throw new Error(`Job node requires a non-empty command: ${node.id}`);
      if (node.command.includes("${")) throw new Error("Shell interpolation is not supported; use a literal command.");
      if (node.tool !== undefined || node.input !== undefined || node.prompt !== undefined) throw new Error(`Invalid job node (tool, input and prompt are not allowed): ${node.id}`);
    } else {
      if (node.command !== undefined) throw new Error(`Tool node cannot have command: ${node.id}`);
      if (!node.tool || !WORKFLOW_TOOLS.includes(node.tool as typeof WORKFLOW_TOOLS[number]) || !registry.get(node.tool)) throw new Error(`Unsupported workflow tool: ${node.tool}`);
      if (node.prompt !== undefined) throw new Error(`Tool node cannot have prompt: ${node.id}`);
      if (node.tool === "run_command" && JSON.stringify(node.input ?? {}).includes("${")) throw new Error("Shell interpolation is not supported; use a literal command.");
      if (!JSON.stringify(node.input ?? {}).includes("${")) validateToolInput(registry, node.tool, node.input ?? {});
      // Mutating tools are never re-run automatically.
      if (node.retry !== undefined && !SAFE_TOOLS.has(node.tool)) throw new Error(`Tool node ${node.id}: retry is only allowed for read-only tools (${[...SAFE_TOOLS].join(", ")}); ${node.tool} may mutate state.`);
    }
  });
  validateScope(definition.nodes, ids, new Set(), undefined);
  return definition;
}
function validateLoopNode(node: WorkflowNode, path: string[]): void {
  if (path.length >= MAX_LOOP_DEPTH) throw new Error(`Loop node ${node.id}: loops may be nested at most ${MAX_LOOP_DEPTH} levels deep.`);
  if (node.retry !== undefined) throw new Error(`Loop nodes do not support retry: ${node.id}`);
  if (node.maxIterations === undefined || node.maxIterations > MAX_LOOP_ITERATIONS) throw new Error(`Loop node ${node.id}: maxIterations (1..${MAX_LOOP_ITERATIONS}) is required.`);
  if (!Array.isArray(node.body) || node.body.length === 0) throw new Error(`Loop node ${node.id}: body must contain at least one node.`);
  const extra = (["tool", "input", "command", "prompt"] as const).find(field => node[field] !== undefined);
  if (extra) throw new Error(`Invalid loop node ${node.id}: ${extra} is not allowed.`);
}
/** Node ids and `loop.*` usage referenced by an expression or a template value. */
function expressionRefs(source: string, label: string): { nodes: string[]; loop: boolean } {
  let ast: ExprNode;
  try { ast = parseExpression(source); }
  catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  let loop = false;
  const walk = (node: ExprNode): void => {
    if (node.kind === "ref") { if (node.root === "loop") loop = true; }
    else if (node.kind === "unary") walk(node.operand);
    else if (node.kind === "binary") { walk(node.left); walk(node.right); }
  };
  walk(ast);
  return { nodes: referencedNodes(ast), loop };
}
/**
 * Validates one sibling scope (the top level or a loop body): dependencies stay inside the scope and are
 * acyclic; references (`when`, templates, loop `until`/`stopWhen`) name a transitive dependency or a node in
 * `outer` (what the enclosing loop itself transitively depends on). `loop` is the enclosing loop id, if any.
 */
function validateScope(nodes: WorkflowNode[], allIds: Set<string>, outer: Set<string>, loop: string | undefined): void {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (!byId.has(id)) {
      if (loop !== undefined && allIds.has(id)) throw new Error(`Loop ${loop} body: dependency ${id} is outside the body (body nodes may only depend on body siblings).`);
      throw new Error(`Unknown dependency: ${id}`);
    }
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) visit(dep);
    visiting.delete(id); done.add(id);
  };
  for (const id of byId.keys()) visit(id);
  // `${nodes.X...}` must name a (transitive) dependency, so X has settled before the reference resolves.
  const ancestors = new Map<string, Set<string>>();
  const ancestorsOf = (id: string): Set<string> => {
    let set = ancestors.get(id);
    if (set) return set;
    set = new Set<string>(outer);
    for (const dep of byId.get(id)!.dependsOn ?? []) { set.add(dep); for (const a of ancestorsOf(dep)) set.add(a); }
    ancestors.set(id, set);
    return set;
  };
  const loopRefError = (node: WorkflowNode, what: string): Error => new Error(`Node ${node.id} ${what} uses loop.* outside a loop body.`);
  for (const node of nodes) {
    if (node.when !== undefined) {
      const refs = expressionRefs(node.when, `Node ${node.id}: invalid when`);
      if (refs.loop && loop === undefined) throw loopRefError(node, "when");
      for (const target of refs.nodes) {
        if (!allIds.has(target)) throw new Error(`Node ${node.id} when references unknown node "${target}".`);
        if (!ancestorsOf(node.id).has(target)) throw new Error(`Node ${node.id} when references node "${target}" which is not one of its dependencies; add it to dependsOn.`);
      }
    }
    const templated = node.type === "tool" ? node.input : node.type === "agent" ? node.task : node.type === "prompt" ? node.prompt : undefined;
    if (templated !== undefined) {
      for (const ref of extractReferences(templated)) {
        if (ref.root === "loop" && loop === undefined) throw loopRefError(node, `(${ref.raw})`);
        if (ref.root !== "nodes") continue;
        const target = ref.path[0]!;
        if (!allIds.has(target)) throw new Error(`Node ${node.id} references unknown node "${target}" (${ref.raw}).`);
        if (!ancestorsOf(node.id).has(target)) throw new Error(`Node ${node.id} references node "${target}" (${ref.raw}) which is not one of its dependencies; add it to dependsOn.`);
      }
    }
    if (node.type === "loop") {
      const body = node.body!;
      // until/stopWhen are evaluated after an iteration: body nodes and the loop's own (transitive) dependencies are visible.
      const visible = new Set([...ancestorsOf(node.id), ...body.map(child => child.id)]);
      if (node.until !== undefined) {
        const refs = expressionRefs(node.until, `Loop ${node.id}: invalid until`);
        for (const target of refs.nodes) {
          if (!allIds.has(target)) throw new Error(`Loop ${node.id} until references unknown node "${target}".`);
          if (!visible.has(target)) throw new Error(`Loop ${node.id} until references node "${target}" which is neither a body node nor a dependency of the loop.`);
        }
      }
      if (node.stopWhen !== undefined) {
        const target = node.stopWhen.node;
        if (!allIds.has(target)) throw new Error(`Loop ${node.id} stopWhen references unknown node "${target}".`);
        if (!visible.has(target)) throw new Error(`Loop ${node.id} stopWhen references node "${target}" which is neither a body node nor a dependency of the loop.`);
      }
      validateScope(body, allIds, ancestorsOf(node.id), node.id);
    }
  }
}
function validateAgentNode(node: WorkflowNode, has: (field: keyof WorkflowNode) => boolean): void {
  for (const field of ["tool", "input", "command"] as const) if (has(field)) throw new Error(`Invalid workflow ${node.type} node ${node.id}: ${field} is not allowed.`);
  if (node.type === "agent") {
    if (!node.agent || !node.task) throw new Error(`Invalid workflow agent node ${node.id}: agent and task are required.`);
    if (has("prompt") || has("allowedTools")) throw new Error(`Invalid workflow agent node ${node.id}: use task (not prompt) and the agent's own tools (allowedTools is for prompt nodes).`);
  } else {
    if (!node.prompt) throw new Error(`Invalid workflow prompt node ${node.id}: prompt is required.`);
    if (has("agent") || has("task")) throw new Error(`Invalid workflow prompt node ${node.id}: agent and task are not allowed (use an agent node).`);
    for (const tool of node.allowedTools ?? []) {
      if (!WORKFLOW_TOOLS.includes(tool as typeof WORKFLOW_TOOLS[number])) throw new Error(`Prompt node ${node.id}: allowedTools entry "${tool}" is not a workflow tool (allowed: ${WORKFLOW_TOOLS.join(", ")}).`);
    }
  }
  if (node.outputSchema !== undefined) {
    if (node.output !== "json") throw new Error(`Node ${node.id}: outputSchema requires output: "json".`);
    // Fresh instance: definitions are re-validated on every read, and a schema with `$id` may only be added once per Ajv.
    try { new Ajv({ allErrors: true, strict: false }).compile(node.outputSchema); }
    catch (error) { throw new Error(`Node ${node.id}: invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
export function validateToolInput(registry: ToolRegistry, name: string, input: Record<string, unknown>): void {
  const check = ajv.compile(registry.get(name)!.schema.inputSchema);
  if (!check(input)) throw new Error(`Invalid ${name} input: ${ajv.errorsText(check.errors)}`);
}
export const WORKFLOW_EXTENSIONS = [".json", ".yaml", ".yml"] as const;
/**
 * Parses JSON or YAML (by extension) into plain JSON data before validation, so the stored
 * definition and its hash are identical for equivalent JSON and YAML sources.
 */
export function parseDefinitionText(text: string, path: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    // Normalize to JSON: YAML-only values (e.g. undefined, non-finite numbers) cannot survive as such.
    const parsed: unknown = parseYAML(text);
    return parsed === undefined ? undefined : JSON.parse(JSON.stringify(parsed)) as unknown;
  }
  return JSON.parse(text) as unknown;
}
export async function loadDefinition(path: string, registry: ToolRegistry): Promise<WorkflowDefinition> {
  return validateDefinition(parseDefinitionText(await readFile(path, "utf8"), path), registry);
}
