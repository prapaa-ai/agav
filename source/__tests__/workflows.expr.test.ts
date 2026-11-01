import { describe, expect, it } from "vitest";
import { evaluateCondition, evaluateExpression, MAX_EXPRESSION_DEPTH, MAX_EXPRESSION_LENGTH, parseExpression, referencedNodes } from "../workflows/expr.js";
import type { TemplateContext } from "../workflows/interpolate.js";

const ctx: TemplateContext = {
  inputs: { env: "prod", count: 3, tags: ["a", "b"], flag: true, obj: { deep: { x: 1 } } },
  nodes: {
    build: { status: "passed", output: { ok: true, items: [{ name: "first" }, { name: "second" }], text: "all tests passed" } },
    lint: { status: "failed", output: "boom" },
    skip: { status: "skipped" },
  },
  loop: { index: 2, prev: { done: false }, history: [1, 2] },
};
const ev = (src: string): unknown => evaluateExpression(src, ctx);

describe("parseExpression", () => {
  it("builds an AST with precedence (&& binds tighter than ||, comparisons tighter than &&)", () => {
    expect(parseExpression("a.b == 1 || true && false".replace("a.b", "inputs.x"))).toEqual({
      kind: "binary", op: "||",
      left: { kind: "binary", op: "==", left: { kind: "ref", root: "inputs", path: ["x"] }, right: { kind: "literal", value: 1 } },
      right: { kind: "binary", op: "&&", left: { kind: "literal", value: true }, right: { kind: "literal", value: false } },
    });
  });
  it("accepts an optional ${...} wrapper and both quote styles", () => {
    expect(parseExpression("${inputs.env == 'prod'}")).toEqual(parseExpression(`inputs.env == "prod"`));
  });
  it("collects referenced node ids", () => {
    expect(referencedNodes(parseExpression("nodes.a.status == 'passed' && (nodes.b.output.x in inputs.tags || !nodes.a.output)")).sort()).toEqual(["a", "b"]);
  });
  it.each([
    ["", /empty expression/],
    ["inputs.x ==", /unexpected end/],
    ["(inputs.x", /expected '\)'/],
    ["inputs.x == 'abc", /unterminated string/],
    ["inputs.x = 1", /unexpected character/],
    ["inputs.x 1", /trailing input/],
    ["foo.bar", /unknown identifier "foo"/],
    ["nodes.a", /nodes.<id>.status/],
    ["nodes.a.status.x", /nodes.<id>.status/],
    ["nodes.a.result", /nodes.<id>.status/],
    ["loop.other", /loop.index/],
    ["inputs", /inputs.<name>/],
    ["inputs.x; process.exit()", /unexpected character/],
    ["1abc", /malformed number/],
    ["inputs.x == `t`", /unexpected character/],
    ["inputs.a[0]", /unexpected character/],
  ])("rejects %j", (src, error) => {
    expect(() => parseExpression(src)).toThrow(error);
  });
  it("enforces the length and depth limits", () => {
    expect(() => parseExpression(`'${"a".repeat(MAX_EXPRESSION_LENGTH)}'`)).toThrow(/longer than 2000/);
    const nested = (n: number): string => "(".repeat(n) + "true" + ")".repeat(n);
    expect(() => parseExpression(nested(MAX_EXPRESSION_DEPTH))).not.toThrow();
    expect(() => parseExpression(nested(MAX_EXPRESSION_DEPTH + 1))).toThrow(/nesting deeper than 32/);
    expect(() => parseExpression("!".repeat(MAX_EXPRESSION_DEPTH + 1) + "true")).toThrow(/nesting/);
  });
});

describe("evaluateExpression", () => {
  it("evaluates literals and references", () => {
    expect(ev("42")).toBe(42);
    expect(ev("1.5")).toBe(1.5);
    expect(ev("-2")).toBe(-2);
    expect(ev("'s'")).toBe("s");
    expect(ev(`"it\\'s"`)).toBe("it's");
    expect(ev("null")).toBeNull();
    expect(ev("inputs.env")).toBe("prod");
    expect(ev("inputs.obj.deep.x")).toBe(1);
    expect(ev("nodes.build.output.items.1.name")).toBe("second");
    expect(ev("loop.index")).toBe(2);
    expect(ev("loop.prev.done")).toBe(false);
    expect(ev("loop.history.0")).toBe(1);
  });
  it("compares values", () => {
    expect(ev("inputs.count == 3")).toBe(true);
    expect(ev("inputs.count != 3")).toBe(false);
    expect(ev("inputs.count < 4 && inputs.count <= 3 && inputs.count > 2 && inputs.count >= 3")).toBe(true);
    expect(ev("'a' < 'b'")).toBe(true);
    expect(ev("inputs.count < '4'")).toBe(false); // ordering across types is false, not coerced
    expect(ev("inputs.count == '3'")).toBe(false); // strict equality
    expect(ev("inputs.tags == inputs.tags")).toBe(true);
    expect(ev("nodes.build.output.ok == true")).toBe(true);
  });
  it("supports logic, negation and parentheses", () => {
    expect(ev("!inputs.flag")).toBe(false);
    expect(ev("!(inputs.flag && false)")).toBe(true);
    expect(ev("false || inputs.env == 'prod'")).toBe(true);
    expect(ev("(true || false) && false")).toBe(false);
  });
  it("supports `in` for arrays and substrings", () => {
    expect(ev("'a' in inputs.tags")).toBe(true);
    expect(ev("'z' in inputs.tags")).toBe(false);
    expect(ev("'tests passed' in nodes.build.output.text")).toBe(true);
    expect(ev("1 in inputs.env")).toBe(false);
    expect(ev("'x' in nodes.missing.output")).toBe(false);
  });
  it("treats missing references as undefined instead of throwing", () => {
    expect(ev("inputs.nope")).toBeUndefined();
    expect(ev("nodes.missing.status")).toBeUndefined();
    expect(ev("nodes.skip.status == 'passed'")).toBe(false);
    expect(ev("nodes.skip.status == 'skipped'")).toBe(true);
    expect(ev("nodes.lint.output")).toBeUndefined(); // only a passed node's output is data
    expect(ev("nodes.build.output.items.9.name")).toBeUndefined();
    expect(ev("nodes.build.output.items.x")).toBeUndefined();
    expect(evaluateExpression("loop.index", { inputs: {}, nodes: {} })).toBeUndefined();
    expect(ev("inputs.nope == null")).toBe(false);
  });
  it("evaluateCondition coerces to boolean", () => {
    expect(evaluateCondition("inputs.env", ctx)).toBe(true);
    expect(evaluateCondition("inputs.nope", ctx)).toBe(false);
    expect(evaluateCondition("inputs.tags", ctx)).toBe(true);
    expect(evaluateCondition(parseExpression("inputs.count > 5"), ctx)).toBe(false);
  });
});

describe("expression safety", () => {
  it.each(["inputs.__proto__", "inputs.constructor", "inputs.x.prototype", "nodes.build.output.constructor.name", "nodes.__proto__.status", "constructor", "loop.prev.__proto__.x"])("rejects the forbidden segment in %j", src => {
    expect(() => parseExpression(src)).toThrow(/forbidden/);
  });
  it("never reaches inherited properties", () => {
    const inputs = Object.create({ inherited: "secret" }) as Record<string, unknown>;
    inputs.own = { toString: "own" };
    const c: TemplateContext = { inputs, nodes: {} };
    expect(evaluateExpression("inputs.inherited", c)).toBeUndefined();
    expect(evaluateExpression("inputs.own.toString", c)).toBe("own");
    expect(evaluateExpression("inputs.own.hasOwnProperty", c)).toBeUndefined();
    expect(evaluateExpression("inputs.own.valueOf", c)).toBeUndefined();
    expect(evaluateExpression("nodes.toString.status", c)).toBeUndefined();
  });
  it("has no call syntax, assignment or code execution", () => {
    for (const src of ["inputs.x()", "inputs.x = 1", "eval('1')", "Function('return 1')", "inputs.x + 1", "this", "globalThis.process", "[1,2]"]) {
      expect(() => parseExpression(src), src).toThrow(/Invalid expression/);
    }
  });
});
