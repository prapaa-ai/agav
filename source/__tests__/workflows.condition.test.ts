import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../workflows/condition.js";
import { validateWorkflow } from "../workflows/validator.js";
import { ToolRegistry } from "../tools/registry.js";
import type { WorkflowDefinition } from "../workflows/types.js";

const ctx = (nodes: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) => ({
  inputs,
  nodes: nodes as never,
});

describe("workflows/condition — when expressions", () => {
  it("treats an absent condition as satisfied", () => {
    expect(evaluateCondition(undefined, ctx())).toEqual({ ok: true });
    expect(evaluateCondition("   ", ctx())).toEqual({ ok: true });
  });

  it("evaluates truthiness of an interpolated value", () => {
    const c = ctx({ gate: { output: { flag: true } } });
    expect(evaluateCondition("${nodes.gate.output.flag}", c).ok).toBe(true);
  });

  it("treats false, 0, empty, null and undefined as falsy", () => {
    for (const value of [false, 0, "", null, undefined]) {
      const c = ctx({ gate: { output: { value } } });
      expect(evaluateCondition("${nodes.gate.output.value}", c).ok, String(value)).toBe(false);
    }
  });

  it("compares strings for equality and inequality", () => {
    const c = ctx({ triage: { output: { severity: "high" } } });
    expect(evaluateCondition('${nodes.triage.output.severity} == "high"', c).ok).toBe(true);
    expect(evaluateCondition('${nodes.triage.output.severity} != "high"', c).ok).toBe(false);
    expect(evaluateCondition('${nodes.triage.output.severity} == "low"', c).ok).toBe(false);
  });

  it("compares numbers, coercing numeric strings", () => {
    const c = ctx({ scan: { output: { count: 3, asText: "3" } } });
    expect(evaluateCondition("${nodes.scan.output.count} > 0", c).ok).toBe(true);
    expect(evaluateCondition("${nodes.scan.output.count} > 5", c).ok).toBe(false);
    expect(evaluateCondition("${nodes.scan.output.count} >= 3", c).ok).toBe(true);
    expect(evaluateCondition("${nodes.scan.output.count} < 5", c).ok).toBe(true);
    expect(evaluateCondition("${nodes.scan.output.count} <= 2", c).ok).toBe(false);
    // "3" from an output string still compares numerically against 3.
    expect(evaluateCondition("${nodes.scan.output.asText} == 3", c).ok).toBe(true);
  });

  it("reads run inputs", () => {
    const c = ctx({}, { mode: "prod", retries: 2 });
    expect(evaluateCondition('${inputs.mode} == "prod"', c).ok).toBe(true);
    expect(evaluateCondition("${inputs.retries} >= 2", c).ok).toBe(true);
    expect(evaluateCondition('${inputs.mode} == "dev"', c).ok).toBe(false);
  });

  it("treats a non-numeric operand in an ordered comparison as not satisfied", () => {
    const c = ctx({ gate: { output: { severity: "high" } } });
    // NaN comparisons must not accidentally pass.
    expect(evaluateCondition("${nodes.gate.output.severity} > 1", c).ok).toBe(false);
  });

  it("supports single quotes", () => {
    const c = ctx({ triage: { output: { severity: "high" } } });
    expect(evaluateCondition("${nodes.triage.output.severity} == 'high'", c).ok).toBe(true);
  });
  it("rejects a malformed when condition before the run starts", async () => {
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: "noop", description: "noop", inputSchema: { type: "object" } },
      execute: async () => ({ output: "ok", isError: false }),
    });

    const deps = { hasTool: (name: string) => registry.list().some((t) => t.schema.name === name) };

    // Missing left-hand operand: interpolates to empty and would compare wrong.
    const malformed = {
      version: 1,
      name: "bad-when",
      nodes: [{ id: "a", type: "tool", tool: "noop", when: '== "high"' }],
    } as unknown as WorkflowDefinition;
    const bad = await validateWorkflow(malformed, deps);
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((issue) => issue.path.endsWith(".when"))).toBe(true);

    // An empty condition is not a condition.
    const empty = {
      version: 1,
      name: "empty-when",
      nodes: [{ id: "a", type: "tool", tool: "noop", when: "   " }],
    } as unknown as WorkflowDefinition;
    expect((await validateWorkflow(empty, deps)).ok).toBe(false);

    // A well-formed condition passes validation.
    const good = {
      version: 1,
      name: "good-when",
      nodes: [{ id: "a", type: "tool", tool: "noop", when: '${inputs.mode} == "prod"' }],
    } as unknown as WorkflowDefinition;
    expect((await validateWorkflow(good, deps)).ok).toBe(true);

    // A bare truthiness condition has no operator and is accepted.
    const bare = {
      version: 1,
      name: "bare-when",
      nodes: [{ id: "a", type: "tool", tool: "noop", when: "${inputs.flag}" }],
    } as unknown as WorkflowDefinition;
    expect((await validateWorkflow(bare, deps)).ok).toBe(true);
  });
});
