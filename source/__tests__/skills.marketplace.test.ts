import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let agavDir = "";
vi.mock("../config/config.js", () => ({
  getAgavDir: () => agavDir,
}));

import { installFromPath, installFromUrl } from "../skills/marketplace.js";

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

// ---------------------------------------------------------------------------
// installFromUrl
// ---------------------------------------------------------------------------

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for URL installation.
---
Do the thing.
`;

describe("skills/marketplace installFromUrl", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    agavDir = await mkdtemp(join(tmpdir(), "agav-home-"));
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ---- success: raw GitHub URL -------------------------------------------

  it("installs a valid skill from a raw GitHub URL", async () => {
    // First fetch: SKILL.md content
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );
    // Second fetch: GitHub API contents listing (fetchGitHubAssets)
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const url = "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/SKILL.md";
    const result = await installFromUrl(url);

    expect(result).toMatchObject({ name: "test-skill" });
    expect("error" in result).toBe(false);
    const dest = join(agavDir, "skills", "test-skill", "SKILL.md");
    await expect(readFile(dest, "utf-8")).resolves.toBe(VALID_SKILL_MD);
  });

  // ---- success: non-GitHub URL -------------------------------------------

  it("installs from a non-GitHub URL and warns about missing assets", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );

    const url = "https://example.com/skills/test-skill/SKILL.md";
    const result = await installFromUrl(url);

    expect(result).toMatchObject({ name: "test-skill" });
    const { warnings } = result as { name: string; warnings: string[] };
    expect(warnings.some((w) => w.includes("Only SKILL.md was fetched"))).toBe(true);
  });

  // ---- HTML response detection -------------------------------------------

  it("returns an error when the response is an HTML page", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("<!DOCTYPE html><html><head></head><body>GitHub page</body></html>", { status: 200 }),
    );

    const url = "https://raw.githubusercontent.com/owner/repo/main/SKILL.md";
    const result = await installFromUrl(url);

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("HTML page");
  });

  it("detects <html tag without doctype", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("<html><head><title>Not a skill</title></head></html>", { status: 200 }),
    );

    const result = await installFromUrl("https://example.com/SKILL.md");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("HTML page");
  });

  // ---- HTTP error --------------------------------------------------------

  it("returns an error on HTTP 404", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    const result = await installFromUrl("https://raw.githubusercontent.com/owner/repo/main/SKILL.md");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("HTTP 404");
  });

  it("returns an error on HTTP 500", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await installFromUrl("https://example.com/SKILL.md");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("HTTP 500");
  });

  // ---- network timeout (AbortError) --------------------------------------

  it("returns a timeout error on AbortError", async () => {
    fetchSpy.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

    const result = await installFromUrl("https://example.com/SKILL.md");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("timed out");
  });

  // ---- validation failure ------------------------------------------------

  it("returns an error when the skill content fails validation", async () => {
    const invalidSkill = `---
description: Missing the name field.
---
Body text here.
`;
    fetchSpy.mockResolvedValueOnce(
      new Response(invalidSkill, { status: 200 }),
    );

    const result = await installFromUrl("https://example.com/SKILL.md");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Validation failed");
  });

  it("returns an error when the skill is missing a body", async () => {
    const noBody = `---
name: no-body
description: Skill with no body.
---
`;
    fetchSpy.mockResolvedValueOnce(
      new Response(noBody, { status: 200 }),
    );

    const result = await installFromUrl("https://example.com/SKILL.md");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Validation failed");
  });

  // ---- normaliseSkillUrl (tested indirectly) -----------------------------

  it("converts a GitHub blob URL to a raw URL", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );
    // GitHub API listing for fetchGitHubAssets
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const blobUrl = "https://github.com/owner/repo/blob/main/skills/test-skill/SKILL.md";
    await installFromUrl(blobUrl);

    // The first fetch should be to the raw URL, not the blob URL
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/SKILL.md",
    );
  });

  it("converts a GitHub tree URL to a raw SKILL.md URL", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const treeUrl = "https://github.com/owner/repo/tree/main/skills/test-skill";
    await installFromUrl(treeUrl);

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/SKILL.md",
    );
  });

  it("converts a bare GitHub repo URL to a raw SKILL.md URL at HEAD", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );

    const repoUrl = "https://github.com/owner/repo";
    await installFromUrl(repoUrl);

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://raw.githubusercontent.com/owner/repo/HEAD/SKILL.md",
    );
  });

  it("converts a bare GitHub repo URL with trailing slash", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );

    const repoUrl = "https://github.com/owner/repo/";
    await installFromUrl(repoUrl);

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://raw.githubusercontent.com/owner/repo/HEAD/SKILL.md",
    );
  });

  it("appends SKILL.md to a raw GitHub URL that does not end in .md", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const rawDirUrl = "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill";
    await installFromUrl(rawDirUrl);

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/SKILL.md",
    );
  });

  it("leaves a raw GitHub SKILL.md URL unchanged", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const rawUrl = "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/SKILL.md";
    await installFromUrl(rawUrl);

    expect(fetchSpy.mock.calls[0]![0]).toBe(rawUrl);
  });

  // ---- fetchGitHubAssets integration ------------------------------------

  it("downloads sibling files from GitHub alongside SKILL.md", async () => {
    // First fetch: SKILL.md
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );
    // Second fetch: GitHub API directory listing
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { name: "SKILL.md", type: "file", path: "skills/test-skill/SKILL.md", download_url: "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/SKILL.md" },
          { name: "helper.py", type: "file", path: "skills/test-skill/helper.py", size: 42, download_url: "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/helper.py" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    // Third fetch: download helper.py
    fetchSpy.mockResolvedValueOnce(
      new Response("print('helper')\n", { status: 200 }),
    );

    const url = "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/SKILL.md";
    const result = await installFromUrl(url);

    expect(result).toMatchObject({ name: "test-skill" });
    const dest = join(agavDir, "skills", "test-skill");
    await expect(readFile(join(dest, "SKILL.md"), "utf-8")).resolves.toBe(VALID_SKILL_MD);
    await expect(readFile(join(dest, "helper.py"), "utf-8")).resolves.toBe("print('helper')\n");
  });

  it("handles GitHub API failure gracefully with a warning", async () => {
    // First fetch: SKILL.md
    fetchSpy.mockResolvedValueOnce(
      new Response(VALID_SKILL_MD, { status: 200 }),
    );
    // Second fetch: GitHub API returns 403
    fetchSpy.mockResolvedValueOnce(
      new Response("Rate limited", { status: 403 }),
    );

    const url = "https://raw.githubusercontent.com/owner/repo/main/skills/test-skill/SKILL.md";
    const result = await installFromUrl(url);

    expect(result).toMatchObject({ name: "test-skill" });
    const { warnings } = result as { name: string; warnings: string[] };
    expect(warnings.some((w) => w.includes("HTTP 403"))).toBe(true);
    // SKILL.md should still be installed
    const dest = join(agavDir, "skills", "test-skill", "SKILL.md");
    await expect(readFile(dest, "utf-8")).resolves.toBe(VALID_SKILL_MD);
  });
});
