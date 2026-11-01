import { describe, expect, it } from "vitest";
import { extractReferences, resolveTemplate, type TemplateContext } from "../workflows/interpolate.js";

const ctx: TemplateContext = {
  inputs: { x: "in", n: 3, obj: { k: 1 } },
  nodes: {
    a: { status: "passed", output: { list: [{ name: "first" }, { name: "second" }], flag: false, nil: null } },
    s: { status: "passed", output: "hello" },
    f: { status: "failed", output: "boom" },
    p: { status: "pending" },
  },
};

describe("resolveTemplate", () => {
  it("resolves inputs, outputs, nested paths and array indexes", () => {
    expect(resolveTemplate("${inputs.x}", ctx)).toBe("in");
    expect(resolveTemplate("${nodes.s.output}", ctx)).toBe("hello");
    expect(resolveTemplate("${nodes.a.output.list.1.name}", ctx)).toBe("second");
    expect(resolveTemplate("${nodes.a.output.flag}", ctx)).toBe(false);
    expect(resolveTemplate("${nodes.a.output.nil}", ctx)).toBeNull();
  });

  it("returns raw values for a whole-string reference and stringifies embedded ones", () => {
    expect(resolveTemplate("${inputs.n}", ctx)).toBe(3);
    expect(resolveTemplate("${nodes.a.output.list}", ctx)).toEqual([{ name: "first" }, { name: "second" }]);
    expect(resolveTemplate("n=${inputs.n} o=${inputs.obj} s=${nodes.s.output}", ctx)).toBe('n=3 o={"k":1} s=hello');
    expect(resolveTemplate("${inputs.x}${inputs.n}", ctx)).toBe("in3");
  });

  it("recurses into objects and arrays, leaving keys and non-strings alone", () => {
    expect(resolveTemplate({ "${inputs.x}": ["${inputs.n}", { deep: "v:${inputs.x}" }, 5, true] }, ctx))
      .toEqual({ "${inputs.x}": [3, { deep: "v:in" }, 5, true] });
  });

  it("resolves node status for any node", () => {
    expect(resolveTemplate("${nodes.f.status}", ctx)).toBe("failed");
    expect(resolveTemplate("${nodes.p.status}", ctx)).toBe("pending");
  });

  it.each([
    ["${inputs.missing}", /unknown input "missing"/],
    ["${nodes.zz.output}", /unknown node "zz"/],
    ["${nodes.f.output}", /has not passed/],
    ["${nodes.p.output}", /has not passed/],
    ["${nodes.a.output.nope}", /no field "nope"/],
    ["${nodes.a.output.list.5}", /no index "5"/],
    ["${nodes.a.output.list.x}", /no index "x"/],
    ["${nodes.s.output.length}", /no field "length"/],
    ["${loop.index}", /not inside a loop/],
    ["${env.HOME}", /unknown root "env"/],
    ["${nodes.a}", /Invalid workflow reference/],
    ["${nodes.a.status.x}", /Invalid workflow reference/],
    ["${inputs.x.y}", /Invalid workflow reference/],
    ["${inputs.x y}", /Invalid workflow reference/],
    ["${}", /Invalid workflow reference/],
  ])("throws for %s", (template, error) => {
    expect(() => resolveTemplate(template, ctx)).toThrow(error);
  });

  it("resolves loop context", () => {
    const loopCtx: TemplateContext = { ...ctx, loop: { index: 2, item: { id: "i" }, prev: { score: 7, tags: ["t"] }, history: [{ score: 1 }, { score: 7 }] } };
    expect(resolveTemplate("${loop.index}", loopCtx)).toBe(2);
    expect(resolveTemplate("${loop.item}", loopCtx)).toEqual({ id: "i" });
    expect(resolveTemplate("${loop.item.id}", loopCtx)).toBe("i");
    expect(resolveTemplate("${loop.prev.score}", loopCtx)).toBe(7);
    expect(resolveTemplate("${loop.prev.tags.0}", loopCtx)).toBe("t");
    expect(resolveTemplate("${loop.history}", loopCtx)).toHaveLength(2);
    expect(resolveTemplate("h=${loop.history}", loopCtx)).toBe('h=[{"score":1},{"score":7}]');
    expect(resolveTemplate("#${loop.index}", loopCtx)).toBe("#2");
  });

  it("rejects loop fields that are not available", () => {
    expect(() => resolveTemplate("${loop.prev}", { ...ctx, loop: { index: 0 } })).toThrow(/loop.prev is not available/);
    expect(() => resolveTemplate("${loop.other}", { ...ctx, loop: { index: 0 } })).toThrow(/Invalid workflow reference/);
  });
});

describe("extractReferences", () => {
  it("collects references from nested values", () => {
    const refs = extractReferences({ a: "x ${inputs.x} ${nodes.a.output.list.0}", b: ["${loop.prev.score}"], c: 1 });
    expect(refs.map(r => [r.root, r.path])).toEqual([["inputs", ["x"]], ["nodes", ["a", "output", "list", "0"]], ["loop", ["prev", "score"]]]);
    expect(refs[0]!.raw).toBe("${inputs.x}");
  });

  it("returns nothing for literal values and throws on malformed references", () => {
    expect(extractReferences({ a: "plain", b: [1, null] })).toEqual([]);
    expect(() => extractReferences("${secrets.x}")).toThrow(/unknown root/);
  });
});
