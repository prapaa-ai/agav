import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let mockAgavDir = "";
vi.mock("../config/config.js", () => ({
  getAgavDir: () => mockAgavDir,
}));

import { loadProjectInstructions } from "../utils/project-instructions.js";

describe("utils/project-instructions", () => {
  let tmpProjectDir: string;
  let tmpGlobalDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpProjectDir = await mkdtemp(join(tmpdir(), "agav-project-"));
    tmpGlobalDir = await mkdtemp(join(tmpdir(), "agav-global-"));
    mockAgavDir = tmpGlobalDir;
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpProjectDir);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    await rm(tmpProjectDir, { recursive: true, force: true });
    await rm(tmpGlobalDir, { recursive: true, force: true });
  });

  it("returns project instructions when only project-level instructions exist", async () => {
    const projectContent = "# Project Rules\nRun tests before commit.";
    await writeFile(join(tmpProjectDir, "AGAV.md"), projectContent);

    const result = await loadProjectInstructions();
    expect(result).toBe(projectContent);
  });

  it("returns global instructions when only global user-level instructions exist", async () => {
    const globalContent = "# Global Preferences\nAlways use TypeScript.";
    await writeFile(join(tmpGlobalDir, "AGAV.md"), globalContent);

    const result = await loadProjectInstructions();
    expect(result).toBe(globalContent);
  });

  it("combines both instructions in the correct order with exactly one blank line", async () => {
    const globalContent = "# Global User Instructions\nPrefer functional programming.";
    const projectContent = "# Project Instructions\nFollow repository ESLint rules.";
    await writeFile(join(tmpGlobalDir, "AGAV.md"), globalContent);
    await writeFile(join(tmpProjectDir, "AGAV.md"), projectContent);

    const result = await loadProjectInstructions();
    expect(result).toBe(`${globalContent}\n\n${projectContent}`);
  });

  it("returns null when neither global nor project instructions exist", async () => {
    const result = await loadProjectInstructions();
    expect(result).toBeNull();
  });

  it("returns project .agavrc when only .agavrc exists", async () => {
    const rcContent = "prefer tabs over spaces";
    await writeFile(join(tmpProjectDir, ".agavrc"), rcContent);

    const result = await loadProjectInstructions();
    expect(result).toBe(rcContent);
  });

  it("preserves AGAV.md precedence over .agavrc when both project files exist", async () => {
    const mdContent = "project AGAV.md instructions";
    const rcContent = "project .agavrc instructions";
    await writeFile(join(tmpProjectDir, "AGAV.md"), mdContent);
    await writeFile(join(tmpProjectDir, ".agavrc"), rcContent);

    const result = await loadProjectInstructions();
    expect(result).toBe(mdContent);
  });

  it("combines global instructions with project .agavrc instructions", async () => {
    const globalContent = "global user instructions";
    const rcContent = "project .agavrc instructions";
    await writeFile(join(tmpGlobalDir, "AGAV.md"), globalContent);
    await writeFile(join(tmpProjectDir, ".agavrc"), rcContent);

    const result = await loadProjectInstructions();
    expect(result).toBe(`${globalContent}\n\n${rcContent}`);
  });

  it("falls back to .agavrc if project AGAV.md is empty whitespace", async () => {
    const rcContent = "project .agavrc instructions";
    await writeFile(join(tmpProjectDir, "AGAV.md"), "   \n\t  ");
    await writeFile(join(tmpProjectDir, ".agavrc"), rcContent);

    const result = await loadProjectInstructions();
    expect(result).toBe(rcContent);
  });

  it("returns null if all instruction files contain only whitespace", async () => {
    await writeFile(join(tmpGlobalDir, "AGAV.md"), "   \n  ");
    await writeFile(join(tmpProjectDir, "AGAV.md"), " \t\n ");
    await writeFile(join(tmpProjectDir, ".agavrc"), "\n\n");

    const result = await loadProjectInstructions();
    expect(result).toBeNull();
  });
});
