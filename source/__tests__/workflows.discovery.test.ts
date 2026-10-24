import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows, resolveWorkflow, looksLikeWorkflowPath } from "../workflows/discovery.js";

describe("workflow discovery", () => {
  let root: string, cwd: string, userDir: string, projectDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agav-wf-disc-"));
    cwd = join(root, "proj"); userDir = join(root, "home", "workflows"); projectDir = join(cwd, ".agav", "workflows");
    await mkdir(projectDir, { recursive: true }); await mkdir(userDir, { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("finds json/yaml/yml in project and user dirs; project shadows user", async () => {
    await writeFile(join(userDir, "shared.json"), "{}");
    await writeFile(join(userDir, "user-only.yml"), "");
    await writeFile(join(projectDir, "shared.yaml"), "");
    await writeFile(join(projectDir, "proj-only.json"), "{}");
    await writeFile(join(projectDir, "notes.txt"), "");
    await writeFile(join(projectDir, ".hidden.json"), "{}");
    await mkdir(join(projectDir, "dir.json"));
    const found = await discoverWorkflows(cwd, { userDir });
    expect(found.map(w => [w.name, w.origin])).toEqual([["proj-only", "project"], ["shared", "project"], ["user-only", "user"]]);
    expect(found.find(w => w.name === "shared")!.path).toBe(join(projectDir, "shared.yaml"));
  });

  it("prefers .json over .yaml over .yml within one directory", async () => {
    await writeFile(join(projectDir, "w.yml"), "");
    await writeFile(join(projectDir, "w.yaml"), "");
    await writeFile(join(projectDir, "w.json"), "{}");
    expect((await discoverWorkflows(cwd, { userDir }))[0]!.path).toBe(join(projectDir, "w.json"));
  });

  it("tolerates missing directories", async () => {
    expect(await discoverWorkflows(join(root, "nowhere"), { userDir: join(root, "none") })).toEqual([]);
  });

  it("resolves names via discovery and paths relative to cwd", async () => {
    await writeFile(join(userDir, "deploy.yaml"), "");
    expect(await resolveWorkflow("deploy", cwd, { userDir })).toMatchObject({ name: "deploy", origin: "user", path: join(userDir, "deploy.yaml") });
    expect(await resolveWorkflow("sub/w.json", cwd, { userDir })).toEqual({ name: "w", origin: "path", path: join(cwd, "sub", "w.json") });
    expect(await resolveWorkflow("w.yml", cwd, { userDir })).toMatchObject({ origin: "path", path: join(cwd, "w.yml") });
    await expect(resolveWorkflow("missing", cwd, { userDir })).rejects.toThrow(/Workflow not found: missing/);
  });

  it("classifies operands", () => {
    expect(looksLikeWorkflowPath("deploy")).toBe(false);
    expect(looksLikeWorkflowPath("./deploy")).toBe(true);
    expect(looksLikeWorkflowPath("/abs/x")).toBe(true);
    expect(looksLikeWorkflowPath("x.JSON")).toBe(true);
  });
});
