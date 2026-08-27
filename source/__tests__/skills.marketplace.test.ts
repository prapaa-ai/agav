import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let agavDir = "";
vi.mock("../config/config.js", () => ({
  getAgavDir: () => agavDir,
}));

import { installFromPath } from "../skills/marketplace.js";

const SKILL_MD = `---
name: pdf-processing
description: Extract PDF text. Use when handling PDFs.
---
Run scripts/extract.py to pull the text out.
`;

let workDir = "";

async function writeSkillTree(root: string): Promise<string> {
  const dir = join(root, "pdf-processing");
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), SKILL_MD);
  await writeFile(join(dir, "scripts", "extract.py"), "print('hi')\n");
  await writeFile(join(dir, "references", "REFERENCE.md"), "# Reference\n");
  return dir;
}

describe("skills/marketplace installFromPath", () => {
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "agav-skill-src-"));
    agavDir = await mkdtemp(join(tmpdir(), "agav-home-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A skill is a directory, not a file. Installing only SKILL.md leaves a body
  // that says "run scripts/extract.py" pointing at nothing.
  it("installs the whole directory when given a skill directory", async () => {
    const src = await writeSkillTree(workDir);

    const result = await installFromPath(src);

    expect(result).toMatchObject({ name: "pdf-processing" });
    const dest = join(agavDir, "skills", "pdf-processing");
    await expect(readFile(join(dest, "SKILL.md"), "utf-8")).resolves.toBe(SKILL_MD);
    await expect(readFile(join(dest, "scripts", "extract.py"), "utf-8")).resolves.toBe("print('hi')\n");
    await expect(readFile(join(dest, "references", "REFERENCE.md"), "utf-8")).resolves.toBe("# Reference\n");
  });

  // Naming a bare SKILL.md must not copy every sibling: the file may be sitting
  // in a downloads folder full of unrelated things.
  it("takes only the spec's asset directories when given a bare SKILL.md", async () => {
    const src = await writeSkillTree(workDir);
    await writeFile(join(src, "unrelated.zip"), "junk");

    const result = await installFromPath(join(src, "SKILL.md"));

    expect(result).toMatchObject({ name: "pdf-processing" });
    const dest = join(agavDir, "skills", "pdf-processing");
    await expect(readFile(join(dest, "scripts", "extract.py"), "utf-8")).resolves.toBe("print('hi')\n");
    await expect(readFile(join(dest, "unrelated.zip"), "utf-8")).rejects.toThrow();
  });

  it("reports a directory with no SKILL.md instead of failing obscurely", async () => {
    const empty = join(workDir, "empty");
    await mkdir(empty, { recursive: true });

    expect(await installFromPath(empty)).toEqual({ error: `No SKILL.md in ${empty}` });
  });

  it("reports a path that does not exist", async () => {
    const missing = join(workDir, "nope");
    expect(await installFromPath(missing)).toEqual({ error: `No such file or directory: ${missing}` });
  });

  it("skips .git and node_modules directories when copying a skill tree", async () => {
    const src = await writeSkillTree(workDir);
    // Add directories that should be skipped
    await mkdir(join(src, ".git", "objects"), { recursive: true });
    await writeFile(join(src, ".git", "HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(src, "node_modules", "dep"), { recursive: true });
    await writeFile(join(src, "node_modules", "dep", "index.js"), "module.exports = {};\n");

    const result = await installFromPath(src);

    expect(result).toMatchObject({ name: "pdf-processing" });
    const dest = join(agavDir, "skills", "pdf-processing");
    // SKILL.md and supporting files should be there
    await expect(readFile(join(dest, "SKILL.md"), "utf-8")).resolves.toBe(SKILL_MD);
    await expect(readFile(join(dest, "scripts", "extract.py"), "utf-8")).resolves.toBe("print('hi')\n");
    // Skipped directories should NOT be there
    const { stat } = await import("node:fs/promises");
    await expect(stat(join(dest, ".git"))).rejects.toThrow();
    await expect(stat(join(dest, "node_modules"))).rejects.toThrow();
  });

  it("rejects a directory that contains nested skills", async () => {
    // Create a parent directory that contains two skill subdirectories
    const parentDir = join(workDir, "skills-collection");
    await mkdir(parentDir, { recursive: true });
    await writeFile(join(parentDir, "SKILL.md"), SKILL_MD);
    // Add a nested skill subdirectory
    const nested = join(parentDir, "child-skill");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "SKILL.md"), `---\nname: child-skill\ndescription: A child\n---\nBody.\n`);

    const result = await installFromPath(parentDir);

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("nested skill");
  });

  it("installs spec asset directories when given a bare SKILL.md but skips unrelated files", async () => {
    const src = await writeSkillTree(workDir);
    // Add an unrelated file that should NOT be copied
    await writeFile(join(src, "random.txt"), "not a skill asset");
    // Add a __pycache__ directory that should be skipped
    await mkdir(join(src, "scripts", "__pycache__"), { recursive: true });
    await writeFile(join(src, "scripts", "__pycache__", "cached.pyc"), "bytecode");

    const result = await installFromPath(join(src, "SKILL.md"));

    expect(result).toMatchObject({ name: "pdf-processing" });
    const dest = join(agavDir, "skills", "pdf-processing");
    // Spec asset dirs should be installed
    await expect(readFile(join(dest, "scripts", "extract.py"), "utf-8")).resolves.toBe("print('hi')\n");
    await expect(readFile(join(dest, "references", "REFERENCE.md"), "utf-8")).resolves.toBe("# Reference\n");
    // Unrelated file should not be there
    const { stat } = await import("node:fs/promises");
    await expect(stat(join(dest, "random.txt"))).rejects.toThrow();
    // __pycache__ should be skipped
    await expect(stat(join(dest, "scripts", "__pycache__"))).rejects.toThrow();
  });
});
