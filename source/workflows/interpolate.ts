/**
 * Workflow template references: `${inputs.x}`, `${nodes.<id>.output[.path]}`, `${nodes.<id>.status}`,
 * `${loop.index}`, `${loop.item[.path]}`, `${loop.prev[.path]}`, `${loop.history[.path]}`.
 * Path segments are object keys or array indexes (`.0`). A string that is exactly one reference
 * resolves to the raw value; embedded references are stringified (objects/arrays JSON-encoded).
 * Missing or malformed references throw. Interpolation never applies to shell command text
 * (enforced by `validateDefinition`).
 */
export interface TemplateContext {
  inputs: Record<string, unknown>;
  nodes: Record<string, { status: string; output?: unknown }>;
  loop?: { index?: number; item?: unknown; prev?: unknown; history?: unknown[] };
}
export interface WorkflowReference {
  /** The full `${...}` text. */
  raw: string;
  root: "inputs" | "nodes" | "loop";
  /** Segments after the root, e.g. `["id", "output", "a", "0"]`. */
  path: string[];
}

const REFERENCE = /\$\{([^}]*)\}/g;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const LOOP_FIELDS = new Set(["index", "item", "prev", "history"]);

function parseReference(raw: string, body: string): WorkflowReference {
  const parts = body.trim().split(".");
  const [root, ...path] = parts;
  if (!parts.every(part => SEGMENT.test(part))) throw new Error(`Invalid workflow reference ${raw}: path segments must be identifiers or indexes.`);
  if (root === "inputs") {
    if (path.length !== 1) throw new Error(`Invalid workflow reference ${raw}: use \${inputs.<name>}.`);
  } else if (root === "nodes") {
    const field = path[1];
    if (path.length < 2 || (field !== "output" && field !== "status") || (field === "status" && path.length !== 2)) throw new Error(`Invalid workflow reference ${raw}: use \${nodes.<id>.output[.path]} or \${nodes.<id>.status}.`);
  } else if (root === "loop") {
    if (path.length < 1 || !LOOP_FIELDS.has(path[0]!) || (path[0] === "index" && path.length !== 1)) throw new Error(`Invalid workflow reference ${raw}: use \${loop.index}, \${loop.item}, \${loop.prev} or \${loop.history}.`);
  } else {
    throw new Error(`Invalid workflow reference ${raw}: unknown root "${root}" (expected inputs, nodes or loop).`);
  }
  return { raw, root, path };
}

/** All references in `value` (recursing into arrays and object values); throws on malformed references. */
export function extractReferences(value: unknown): WorkflowReference[] {
  const found: WorkflowReference[] = [];
  const walk = (item: unknown): void => {
    if (typeof item === "string") { for (const match of item.matchAll(REFERENCE)) found.push(parseReference(match[0], match[1]!)); }
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object") Object.values(item).forEach(walk);
  };
  walk(value);
  return found;
}

function walkPath(base: unknown, path: string[], ref: WorkflowReference): unknown {
  let current = base;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= current.length) throw new Error(`Unresolved workflow reference ${ref.raw}: no index "${segment}".`);
      current = current[Number(segment)];
    } else if (current && typeof current === "object" && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`Unresolved workflow reference ${ref.raw}: no field "${segment}".`);
    }
  }
  if (current === undefined) throw new Error(`Unresolved workflow reference ${ref.raw}: value is undefined.`);
  return current;
}

function lookup(ref: WorkflowReference, ctx: TemplateContext): unknown {
  const [head, ...rest] = ref.path;
  if (ref.root === "inputs") {
    if (!Object.hasOwn(ctx.inputs, head!)) throw new Error(`Unresolved workflow reference ${ref.raw}: unknown input "${head}".`);
    return walkPath(ctx.inputs[head!], [], ref);
  }
  if (ref.root === "nodes") {
    const node = Object.hasOwn(ctx.nodes, head!) ? ctx.nodes[head!] : undefined;
    if (!node) throw new Error(`Unresolved workflow reference ${ref.raw}: unknown node "${head}".`);
    const [field, ...path] = rest;
    if (field === "status") return node.status;
    // Only a passed node's output is data; failed/pending outputs are absent or error text.
    if (node.status !== "passed") throw new Error(`Unresolved workflow reference ${ref.raw}: node "${head}" has not passed (status ${node.status}).`);
    return walkPath(node.output, path, ref);
  }
  if (!ctx.loop) throw new Error(`Unresolved workflow reference ${ref.raw}: not inside a loop.`);
  if (!Object.hasOwn(ctx.loop, head!) || ctx.loop[head as keyof typeof ctx.loop] === undefined) throw new Error(`Unresolved workflow reference ${ref.raw}: loop.${head} is not available.`);
  return walkPath(ctx.loop[head as keyof typeof ctx.loop], rest, ref);
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Resolves every reference in `value`, recursing into arrays and object values (keys are literal). */
export function resolveTemplate(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{([^}]*)\}$/.exec(value);
    if (whole) return lookup(parseReference(value, whole[1]!), ctx);
    return value.replace(REFERENCE, (raw, body: string) => stringify(lookup(parseReference(raw, body), ctx)));
  }
  if (Array.isArray(value)) return value.map(item => resolveTemplate(item, ctx));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, ctx)]));
  return value;
}
