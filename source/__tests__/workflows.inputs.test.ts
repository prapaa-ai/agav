import { describe, expect, it, afterEach } from "vitest";
import { resolveInputs } from "../workflows/inputs.js";
import { createRun } from "../workflows/runtime.js";
import { def, tempStore, registry } from "./helpers/workflow-fixtures.js";

const gate = [{ id: "a", type: "approval" as const, prompt: "p" }];

describe("resolveInputs", () => {
  const d = def(gate, { inputs: {
    target: { type: "string", required: true },
    count: { type: "number", default: 2 },
    verbose: { type: "boolean" },
    opts: { type: "object", default: { a: 1 } },
    list: { type: "array" },
  } });

  it("applies defaults and keeps provided values", () => {
    expect(resolveInputs(d, { target: "src", verbose: true })).toEqual({ target: "src", count: 2, verbose: true, opts: { a: 1 } });
  });
  it("clones object defaults so runs cannot alias the definition", () => {
    const resolved = resolveInputs(d, { target: "x" });
    (resolved.opts as Record<string, unknown>).a = 9;
    expect(d.inputs!.opts!.default).toEqual({ a: 1 });
  });
  it("enforces required inputs", () => {
    expect(() => resolveInputs(d, {})).toThrow(/Missing required workflow input: target/);
  });
  it.each([
    ["string", { target: 1 }],
    ["number", { target: "x", count: "2" }],
    ["number (non-finite)", { target: "x", count: Number.NaN }],
    ["boolean", { target: "x", verbose: "true" }],
    ["object", { target: "x", opts: [] }],
    ["array", { target: "x", list: {} }],
  ])("enforces type %s", (_label, provided) => {
    expect(() => resolveInputs(d, provided)).toThrow(/must be of type/);
  });
  it("rejects undeclared inputs (fail closed)", () => {
    expect(() => resolveInputs(d, { target: "x", other: 1 })).toThrow(/Unknown workflow input: other/);
  });
  it("keeps untyped behavior when no inputs are declared", () => {
    expect(resolveInputs(def(gate), { anything: [1] })).toEqual({ anything: [1] });
  });
  it("rejects non-object inputs", () => {
    expect(() => resolveInputs(d, [] as unknown as Record<string, unknown>)).toThrow(/JSON object/);
  });
});

describe("createRun with typed inputs", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  it("stores resolved inputs and refuses invalid ones before persisting anything", async () => {
    const t = await tempStore(); cleanup = t.cleanup;
    const d = def(gate, { inputs: { n: { type: "number", default: 5 } } });
    const run = await createRun(t.store, d, {});
    expect(run.inputs).toEqual({ n: 5 });
    expect((await t.store.read(run.id, registry)).inputs).toEqual({ n: 5 });
    await expect(createRun(t.store, d, { n: "5" })).rejects.toThrow(/must be of type number/);
  });
});
