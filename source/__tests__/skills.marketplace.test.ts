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
});
