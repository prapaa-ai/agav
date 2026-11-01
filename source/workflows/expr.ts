/**
 * Safe workflow expression language for `when` (and later `loop.until`). Hand-written tokenizer,
 * recursive-descent parser and tree-walking evaluator: no `eval`, no `Function`, no property access
 * beyond own data properties of plain objects/arrays.
 *
 * Grammar (lowest to highest precedence):
 *   expr       := or
 *   or         := and ("||" and)*
 *   and        := comparison ("&&" comparison)*
 *   comparison := unary (("==" | "!=" | "<" | "<=" | ">" | ">=" | "in") unary)*
 *   unary      := ("!" | "-") unary | primary
 *   primary    := number | string | true | false | null | reference | "(" expr ")"
 *   reference  := ("inputs" | "nodes" | "loop") ("." segment)+
 *
 * References: `inputs.<name>[.path]`, `nodes.<id>.status`, `nodes.<id>.output[.path]`,
 * `loop.index`, `loop.item|prev|history[.path]`; path segments are keys or array indexes (`.0`).
 * A missing reference evaluates to `undefined` (never throws), so `nodes.x.status == 'passed'` is
 * simply false for a skipped x. An optional `${...}` wrapper around the whole expression is accepted.
 */
import type { TemplateContext } from "./interpolate.js";

/** Hard limits: source length (characters) and parenthesis/unary nesting depth. */
export const MAX_EXPRESSION_LENGTH = 2000;
export const MAX_EXPRESSION_DEPTH = 32;

export type BinaryOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "&&" | "||";
export type ExprNode =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "ref"; root: "inputs" | "nodes" | "loop"; path: string[] }
  | { kind: "unary"; op: "!" | "-"; operand: ExprNode }
  | { kind: "binary"; op: BinaryOperator; left: ExprNode; right: ExprNode };

type Token =
  | { type: "num"; value: number; pos: number }
  | { type: "str"; value: string; pos: number }
  | { type: "ident"; value: string; segments: string[]; pos: number }
  | { type: "op"; value: string; pos: number }
  | { type: "eof"; pos: number };

/** Segments that could reach prototype machinery are refused outright. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ROOTS = new Set(["inputs", "nodes", "loop"]);
const LOOP_FIELDS = new Set(["index", "item", "prev", "history"]);
const OPERATORS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "(", ")", "-"];

function syntaxError(message: string, pos: number): Error {
  return new Error(`Invalid expression: ${message} at position ${pos}.`);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (/[0-9]/.test(ch)) {
      const match = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/.exec(src.slice(i))!;
      i += match[0].length;
      if (i < src.length && /[A-Za-z0-9_.]/.test(src[i]!)) throw syntaxError("malformed number", start);
      tokens.push({ type: "num", value: Number(match[0]), pos: start });
      continue;
    }
    if (ch === "'" || ch === '"') {
      let value = "";
      i++;
      for (;;) {
        if (i >= src.length) throw syntaxError("unterminated string", start);
        const c = src[i]!;
        if (c === ch) { i++; break; }
        if (c === "\\") {
          const next = src[i + 1];
          if (next === undefined) throw syntaxError("unterminated string", start);
          const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
          if (!Object.hasOwn(escapes, next)) throw syntaxError(`unknown escape \\${next}`, i);
          value += escapes[next]; i += 2; continue;
        }
        value += c; i++;
      }
      tokens.push({ type: "str", value, pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))![0];
      i += root.length;
      const segments: string[] = [];
      while (src[i] === ".") {
        const seg = /^[A-Za-z0-9_-]+/.exec(src.slice(i + 1));
        if (!seg) throw syntaxError("expected a path segment after '.'", i);
        if (FORBIDDEN_SEGMENTS.has(seg[0])) throw syntaxError(`forbidden path segment "${seg[0]}"`, i + 1);
        segments.push(seg[0]);
        i += 1 + seg[0].length;
      }
      if (FORBIDDEN_SEGMENTS.has(root)) throw syntaxError(`forbidden identifier "${root}"`, start);
      tokens.push({ type: "ident", value: root, segments, pos: start });
      continue;
    }
    const op = OPERATORS.find(candidate => src.startsWith(candidate, i));
    if (!op) throw syntaxError(`unexpected character ${JSON.stringify(ch)}`, i);
    i += op.length;
    tokens.push({ type: "op", value: op, pos: start });
  }
  tokens.push({ type: "eof", pos: src.length });
  return tokens;
}

function validateReference(root: string, path: string[], pos: number): ExprNode {
  if (!ROOTS.has(root)) throw syntaxError(`unknown identifier "${root}" (expected inputs, nodes, loop, true, false or null)`, pos);
  if (root === "inputs" && path.length < 1) throw syntaxError("use inputs.<name>", pos);
  if (root === "nodes") {
    const field = path[1];
    if (path.length < 2 || (field !== "status" && field !== "output") || (field === "status" && path.length !== 2)) throw syntaxError("use nodes.<id>.status or nodes.<id>.output[.path]", pos);
  }
  if (root === "loop" && (path.length < 1 || !LOOP_FIELDS.has(path[0]!) || (path[0] === "index" && path.length !== 1))) throw syntaxError("use loop.index, loop.item, loop.prev or loop.history", pos);
  return { kind: "ref", root: root as "inputs" | "nodes" | "loop", path };
}

class Parser {
  private index = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek(): Token { return this.tokens[this.index]!; }
  private isOp(value: string): boolean { const t = this.peek(); return (t.type === "op" && t.value === value) || (value === "in" && t.type === "ident" && t.value === "in" && t.segments.length === 0); }
  private enter(): void { if (++this.depth > MAX_EXPRESSION_DEPTH) throw syntaxError(`nesting deeper than ${MAX_EXPRESSION_DEPTH}`, this.peek().pos); }
  parse(): ExprNode {
    if (this.peek().type === "eof") throw syntaxError("empty expression", 0);
    const node = this.or();
    const rest = this.peek();
    if (rest.type !== "eof") throw syntaxError("unexpected trailing input", rest.pos);
    return node;
  }
  private or(): ExprNode {
    let left = this.and();
    while (this.isOp("||")) { this.index++; left = { kind: "binary", op: "||", left, right: this.and() }; }
    return left;
  }
  private and(): ExprNode {
    let left = this.comparison();
    while (this.isOp("&&")) { this.index++; left = { kind: "binary", op: "&&", left, right: this.comparison() }; }
    return left;
  }
  private comparison(): ExprNode {
    let left = this.unary();
    for (;;) {
      const op = (["==", "!=", "<=", ">=", "<", ">", "in"] as const).find(candidate => this.isOp(candidate));
      if (!op) return left;
      this.index++;
      left = { kind: "binary", op, left, right: this.unary() };
    }
  }
  private unary(): ExprNode {
    if (this.isOp("!") || this.isOp("-")) {
      const op = (this.peek() as { value: string }).value as "!" | "-";
      this.index++;
      this.enter();
      const operand = this.unary();
      this.depth--;
      return { kind: "unary", op, operand };
    }
    return this.primary();
  }
  private primary(): ExprNode {
    const token = this.peek();
    if (token.type === "num" || token.type === "str") { this.index++; return { kind: "literal", value: token.value }; }
    if (token.type === "ident") {
      this.index++;
      if (token.segments.length === 0) {
        if (token.value === "true") return { kind: "literal", value: true };
        if (token.value === "false") return { kind: "literal", value: false };
        if (token.value === "null") return { kind: "literal", value: null };
        if (token.value === "in") throw syntaxError("unexpected 'in'", token.pos);
      }
      return validateReference(token.value, token.segments, token.pos);
    }
    if (token.type === "op" && token.value === "(") {
      this.index++;
      this.enter();
      const inner = this.or();
      this.depth--;
      if (!this.isOp(")")) throw syntaxError("expected ')'", this.peek().pos);
      this.index++;
      return inner;
    }
    throw syntaxError(token.type === "eof" ? "unexpected end of expression" : `unexpected token "${token.value}"`, token.pos);
  }
}

/** Strips an optional whole-expression `${...}` wrapper. */
function unwrap(src: string): string {
  const trimmed = src.trim();
  return trimmed.startsWith("${") && trimmed.endsWith("}") ? trimmed.slice(2, -1) : trimmed;
}

/** Parses an expression into an AST; throws a descriptive error on any syntax or limit violation. */
export function parseExpression(src: string): ExprNode {
  if (typeof src !== "string") throw new Error("Invalid expression: must be a string.");
  if (src.length > MAX_EXPRESSION_LENGTH) throw new Error(`Invalid expression: longer than ${MAX_EXPRESSION_LENGTH} characters.`);
  return new Parser(tokenize(unwrap(src))).parse();
}

/** Every `nodes.<id>` id referenced by the expression (for dependency validation). */
export function referencedNodes(ast: ExprNode): string[] {
  const ids = new Set<string>();
  const walk = (node: ExprNode): void => {
    if (node.kind === "ref") { if (node.root === "nodes") ids.add(node.path[0]!); }
    else if (node.kind === "unary") walk(node.operand);
    else if (node.kind === "binary") { walk(node.left); walk(node.right); }
  };
  walk(ast);
  return [...ids];
}

/** Own-property walk over plain objects/arrays only; anything missing is undefined. */
function walk(base: unknown, path: string[]): unknown {
  let current = base;
  for (const segment of path) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      current = Number(segment) < current.length ? current[Number(segment)] : undefined;
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function lookup(ref: Extract<ExprNode, { kind: "ref" }>, ctx: TemplateContext): unknown {
  const [head, ...rest] = ref.path;
  if (ref.root === "inputs") return Object.hasOwn(ctx.inputs, head!) ? walk(ctx.inputs[head!], rest) : undefined;
  if (ref.root === "nodes") {
    const node = Object.hasOwn(ctx.nodes, head!) ? ctx.nodes[head!] : undefined;
    if (!node) return undefined;
    const [field, ...path] = rest;
    if (field === "status") return node.status;
    // As in interpolation, only a passed node's output is data.
    return node.status === "passed" ? walk(node.output, path) : undefined;
  }
  if (!ctx.loop || !Object.hasOwn(ctx.loop, head!)) return undefined;
  return walk(ctx.loop[head as keyof typeof ctx.loop], rest);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(key => Object.hasOwn(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

function compare(op: "<" | "<=" | ">" | ">=", a: unknown, b: unknown): boolean {
  // Ordering is only defined between two numbers or two strings; anything else is false.
  if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) return false;
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
  }
}

function truthy(value: unknown): boolean {
  return Array.isArray(value) ? true : Boolean(value);
}

function evaluate(node: ExprNode, ctx: TemplateContext): unknown {
  switch (node.kind) {
    case "literal": return node.value;
    case "ref": return lookup(node, ctx);
    case "unary": {
      const value = evaluate(node.operand, ctx);
      if (node.op === "!") return !truthy(value);
      return typeof value === "number" ? -value : undefined;
    }
    case "binary": {
      if (node.op === "&&") return truthy(evaluate(node.left, ctx)) && truthy(evaluate(node.right, ctx));
      if (node.op === "||") return truthy(evaluate(node.left, ctx)) || truthy(evaluate(node.right, ctx));
      const left = evaluate(node.left, ctx), right = evaluate(node.right, ctx);
      switch (node.op) {
        case "==": return deepEqual(left, right);
        case "!=": return !deepEqual(left, right);
        case "in":
          if (Array.isArray(right)) return right.some(item => deepEqual(item, left));
          if (typeof right === "string" && typeof left === "string") return right.includes(left);
          return false;
        default: return compare(node.op, left, right);
      }
    }
  }
}

/** Evaluates a parsed AST (or source text) against the same context shape as interpolation. */
export function evaluateExpression(expr: ExprNode | string, ctx: TemplateContext): unknown {
  return evaluate(typeof expr === "string" ? parseExpression(expr) : expr, ctx);
}

/** Truthiness of an expression (empty string, 0, null, undefined and false are false). */
export function evaluateCondition(expr: ExprNode | string, ctx: TemplateContext): boolean {
  return truthy(evaluateExpression(expr, ctx));
}
