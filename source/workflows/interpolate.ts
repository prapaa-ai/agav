import type { WorkflowNodeRun } from "./types.js";

export interface WorkflowInterpolationContext {
  inputs: Record<string, unknown>;
  nodes: Record<string, WorkflowNodeRun>;
}

export function interpolateValue(value: unknown, context: WorkflowInterpolationContext): unknown {
  if (typeof value === "string") return interpolateString(value, context);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, interpolateValue(val, context)]),
    );
  }
  return value;
}

export function interpolateString(template: string, context: WorkflowInterpolationContext): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const value = resolvePath(expr.trim(), context);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}

function resolvePath(path: string, context: WorkflowInterpolationContext): unknown {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return undefined;

  let current: unknown;
  if (parts[0] === "inputs") {
    current = context.inputs;
    parts.shift();
  } else if (parts[0] === "nodes") {
    current = context.nodes;
    parts.shift();
  } else {
    return undefined;
  }

  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}
