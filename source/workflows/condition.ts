import { interpolateString, type WorkflowInterpolationContext } from "./interpolate.js";

/**
 * Evaluate a node's `when` condition.
 *
 * Deliberately not a general expression language. A dark factory routes on
 * decisions, so the useful surface is small: does a value look true, and does it
 * compare equal / not equal / greater / less against a literal. Anything more
 * invites YAML that is hard to reason about when a run misbehaves.
 *
 * Returns `true` when there is no condition, so an absent `when` never blocks.
 */
export function evaluateCondition(
  condition: string | undefined,
  context: WorkflowInterpolationContext,
): { ok: boolean; reason?: string } {
  if (condition === undefined || condition.trim() === "") return { ok: true };

  // Interpolate first, so `${nodes.x.output.flag}` yields its real value. The
  // interpolation marker is replaced with a quoted token when the value is a
  // string, which keeps `== "high"` comparing against a string rather than the
  // literal template text.
  const interpolated = interpolateString(condition, context).trim();
  const parsed = parseComparison(interpolated);
  if (!parsed) {
    return { ok: isTruthy(interpolated), reason: interpolated };
  }

  const { left, operator, right } = parsed;
  switch (operator) {
    case "==":
      return { ok: looseEquals(left, right), reason: interpolated };
    case "!=":
      return { ok: !looseEquals(left, right), reason: interpolated };
    case ">":
      return { ok: compareNumbers(left, right, (a, b) => a > b), reason: interpolated };
    case ">=":
      return { ok: compareNumbers(left, right, (a, b) => a >= b), reason: interpolated };
    case "<":
      return { ok: compareNumbers(left, right, (a, b) => a < b), reason: interpolated };
    case "<=":
      return { ok: compareNumbers(left, right, (a, b) => a <= b), reason: interpolated };
    default:
      return { ok: false, reason: interpolated };
  }
}

interface Comparison {
  left: string;
  operator: string;
  right: string;
}

/** Match a leading operand, an operator, and a trailing operand. */
function parseComparison(input: string): Comparison | undefined {
  const match = /^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/.exec(input);
  if (!match) return undefined;
  const [, left, operator, right] = match;
  if (left.trim() === "") return undefined;
  return { left: left.trim(), operator, right: right.trim() };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isTruthy(value: string): boolean {
  const raw = unquote(value).trim();
  if (raw === "") return false;
  const lowered = raw.toLowerCase();
  if (lowered === "false" || lowered === "0" || lowered === "null" || lowered === "undefined") return false;
  if (lowered === "true" || lowered === "1") return true;
  // An array or object from a previous node's output is meaningfully truthy even
  // though its string form is not "true".
  return true;
}

function looseEquals(left: string, right: string): boolean {
  const a = unquote(left);
  const b = unquote(right);
  if (a === b) return true;
  // Compare numerically when both sides look numeric, so "3" == 3 holds.
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return false;
}

function compareNumbers(left: string, right: string, cmp: (a: number, b: number) => boolean): boolean {
  const a = Number(unquote(left));
  const b = Number(unquote(right));
  // A non-numeric operand means the comparison cannot be satisfied, rather than
  // silently comparing NaN and returning false for the wrong reason.
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return cmp(a, b);
}
