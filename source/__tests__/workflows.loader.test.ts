import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkflows, loadWorkflow, resolveWorkflowPath } from "../workflows/loader.js";

function workflowYaml(name: string): string {
  return [
    "version: 1",
    `name: ${name}`,
    `description: ${name} description`,
    "nodes:",
    "  - id: approve",
    "    type: approval",
    "    prompt: continue?",
  ].join("\n");
}

describe("workflow loader", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), "agav-workflow-loader-"));
    process.chdir(root);
    await mkdir(join(root, ".agav", "workflows"), { recursive: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  it("loads workflow YAML by name from project workflow directory", async () => {
    await writeFile(join(root, ".agav", "workflows", "demo.yaml"), workflowYaml("demo"));

    const loaded = await loadWorkflow("demo", root);

    expect(loaded.definition).toMatchObject({ version: 1, name: "demo" });
    expect(loaded.path).toBe(await resolveWorkflowPath("demo", root));
  });

  it("loads workflow JSON by explicit path", async () => {
    const path = join(root, "flow.json");
    await writeFile(path, JSON.stringify({ version: 1, name: "json-flow", nodes: [{ id: "approve", type: "approval", prompt: "ok?" }] }));

    const loaded = await loadWorkflow(path, root);

    expect(loaded.definition.name).toBe("json-flow");
  });

  it("lists project workflows", async () => {
    await writeFile(join(root, ".agav", "workflows", "a.yaml"), workflowYaml("a"));
    await writeFile(join(root, ".agav", "workflows", "b.yml"), workflowYaml("b"));

    const workflows = await listWorkflows(root);

    expect(workflows.map((workflow) => workflow.definition.name).sort()).toEqual(["a", "b"]);
  });
});
