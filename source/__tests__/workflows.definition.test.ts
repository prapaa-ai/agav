import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDefinition, validateDefinition, parseDefinitionText } from "../workflows/definition.js";
import { definitionHash } from "../workflows/store.js";
import { registry } from "./helpers/workflow-fixtures.js";

const base = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, name: "x", ...extra, nodes });

describe("validateDefinition", () => {
  it("accepts a valid tool/approval/job DAG", () => {
    const d = validateDefinition(base([
      { id: "a", type: "tool", tool: "list_directory", input: { path: "." } },
      { id: "gate", type: "approval", prompt: "ok?", dependsOn: ["a"] },
      { id: "j", type: "job", command: "echo hi", dependsOn: ["gate"] },
    ]), registry);
    expect(d.nodes).toHaveLength(3);
  });

  it.each([
    ["dependency cycle", base([{ id: "a", type: "approval", prompt: "p", dependsOn: ["b"] }, { id: "b", type: "approval", prompt: "p", dependsOn: ["a"] }]), /Dependency cycle/],
    ["unknown dependency", base([{ id: "a", type: "approval", prompt: "p", dependsOn: ["nope"] }]), /Unknown dependency: nope/],
    ["duplicate node", base([{ id: "a", type: "approval", prompt: "p" }, { id: "a", type: "approval", prompt: "p" }]), /Duplicate node/],
    ["job command interpolation", base([{ id: "j", type: "job", command: "echo ${inputs.x}" }]), /Shell interpolation is not supported/],
    ["run_command interpolation", base([{ id: "t", type: "tool", tool: "run_command", input: { command: "echo ${inputs.x}" } }]), /Shell interpolation is not supported/],
    ["approval timeout (approvals wait until decided)", base([{ id: "a", type: "approval", prompt: "p", timeoutSeconds: 5 }]), /do not support timeoutSeconds/],
    ["unknown node type", base([{ id: "j", type: "agent" }]), /Invalid workflow/],
    ["path-like id", base([{ id: "../x", type: "approval", prompt: "p" }]), /Invalid workflow/],
    ["unsupported tool", base([{ id: "t", type: "tool", tool: "run_background_job", input: {} }]), /Unsupported workflow tool/],
    ["extra top-level property", base([{ id: "a", type: "approval", prompt: "p" }], { extra: 1 }), /Invalid workflow/],
    ["approval with tool", base([{ id: "a", type: "approval", prompt: "p", tool: "read_file" }]), /Invalid approval node/],
    ["invalid static tool input", base([{ id: "t", type: "tool", tool: "read_file", input: {} }]), /Invalid read_file input/],
  ])("rejects %s", (_label, value, error) => {
    expect(() => validateDefinition(value, registry)).toThrow(error);
  });

  it("allows interpolation into non-shell tool input", () => {
    expect(() => validateDefinition(base([{ id: "t", type: "tool", tool: "write_file", input: { path: "o.txt", content: "${inputs.x}" } }]), registry)).not.toThrow();
  });

  describe("typed inputs", () => {
    const node = [{ id: "a", type: "approval", prompt: "p" }];
    it("accepts a well-formed inputs block", () => {
      const d = validateDefinition(base(node, { inputs: { target: { type: "string", required: true, description: "d" }, n: { type: "number", default: 3 }, flags: { type: "array", default: [] } } }), registry);
      expect(d.inputs?.n?.default).toBe(3);
    });
    it.each([
      ["unknown type", { x: { type: "date" } }, /Invalid workflow/],
      ["extra property", { x: { type: "string", secret: true } }, /Invalid workflow/],
      ["missing type", { x: { default: "a" } }, /Invalid workflow/],
      ["bad name", { "a-b": { type: "string" } }, /Invalid workflow/],
      ["default type mismatch", { x: { type: "number", default: "3" } }, /default must be of type number/],
      ["array default for object", { x: { type: "object", default: [] } }, /default must be of type object/],
      ["required with default", { x: { type: "string", required: true, default: "a" } }, /required input cannot have a default/],
    ])("rejects %s", (_label, inputs, error) => {
      expect(() => validateDefinition(base(node, { inputs }), registry)).toThrow(error);
    });
  });
});

describe("loadDefinition (JSON and YAML)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "agav-wf-def-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const json = base([{ id: "a", type: "tool", tool: "list_directory", input: { path: "." } }, { id: "b", type: "approval", prompt: "go?", dependsOn: ["a"] }]);
  const yamlText = `version: 1
name: x
nodes:
  - id: a
    type: tool
    tool: list_directory
    input:
      path: "."
  - id: b
    type: approval
    prompt: go?
    dependsOn: [a]
`;

  it("loads YAML (.yaml and .yml) to the same normalized definition and hash as JSON", async () => {
    await writeFile(join(dir, "w.json"), JSON.stringify(json));
    await writeFile(join(dir, "w.yaml"), yamlText);
    await writeFile(join(dir, "w.yml"), yamlText);
    const fromJson = await loadDefinition(join(dir, "w.json"), registry);
    const fromYaml = await loadDefinition(join(dir, "w.yaml"), registry);
    const fromYml = await loadDefinition(join(dir, "w.yml"), registry);
    expect(fromYaml).toEqual(fromJson);
    expect(definitionHash(fromYaml)).toBe(definitionHash(fromJson));
    expect(definitionHash(fromYml)).toBe(definitionHash(fromJson));
  });

  it("validates YAML with the same fail-closed rules", async () => {
    await writeFile(join(dir, "bad.yaml"), "version: 1\nname: x\nnodes:\n  - id: j\n    type: job\n    command: echo ${inputs.x}\n");
    await expect(loadDefinition(join(dir, "bad.yaml"), registry)).rejects.toThrow(/Shell interpolation/);
  });

  it("rejects malformed files", async () => {
    await writeFile(join(dir, "bad.json"), "{ nope");
    await writeFile(join(dir, "empty.yaml"), "");
    await expect(loadDefinition(join(dir, "bad.json"), registry)).rejects.toThrow();
    await expect(loadDefinition(join(dir, "empty.yaml"), registry)).rejects.toThrow(/Invalid workflow/);
  });

  it("parses by extension, treating unknown extensions as JSON", () => {
    expect(parseDefinitionText("a: 1", "x.YML")).toEqual({ a: 1 });
    expect(() => parseDefinitionText("a: 1", "x.txt")).toThrow();
  });
});
