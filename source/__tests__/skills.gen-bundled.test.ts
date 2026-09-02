import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

const VALID_SKILL = `---
name: test-skill
description: A test skill
---
Does test things.
`;

/**
 * A minimal reproduction of scripts/gen-bundled-skills.mjs that accepts
 * the project root as a CLI argument instead of deriving it from import.meta.url.
 *
 * The logic is kept identical to the real script so we can exercise its error
 * paths (missing SKILL.md, zero skills) without touching production files.
 */
const GEN_SCRIPT = `
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const bundledDir = join(root, "source", "skills", "bundled");
const outFile = join(root, "source", "skills", "bundled-manifest.ts");

const entries = readdirSync(bundledDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const records = [];
const failed = [];
for (const name of entries) {
  let text;
  try {
    text = readFileSync(join(bundledDir, name, "SKILL.md"), "utf-8");
  } catch {
    failed.push(name);
    continue;
  }
  records.push("  " + JSON.stringify(name) + ": " + JSON.stringify(text.replace(/\\r\\n/g, "\\n")) + ",");
}

const out = "// GENERATED\\nexport const BUNDLED_SKILL_FILES: Record<string, string> = {\\n" + records.join("\\n") + "\\n};\\n";

if (failed.length > 0) {
  console.error("gen:skills — FATAL: missing SKILL.md in bundled directories: " + failed.join(", "));
  console.error("Every directory under source/skills/bundled/ must contain a SKILL.md file.");
  process.exit(1);
}

if (records.length === 0) {
  console.error("gen:skills — FATAL: no bundled skills found. The binary would ship with zero built-in skills.");
  process.exit(1);
}

writeFileSync(outFile, out);
console.log("gen:skills — wrote " + records.length + " skills to bundled-manifest.ts");
`;

describe("scripts/gen-bundled-skills", () => {
  let tmpDir: string;
  let scriptPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agav-gen-test-"));
    // Create required directory structure
    await mkdir(join(tmpDir, "source", "skills", "bundled"), {
      recursive: true,
    });
    // Write the test runner script
    scriptPath = join(tmpDir, "gen-test.mjs");
    await writeFile(scriptPath, GEN_SCRIPT);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("exits with code 1 when a bundled directory is missing SKILL.md", async () => {
    // Create a directory without SKILL.md
    await mkdir(
      join(tmpDir, "source", "skills", "bundled", "broken-skill"),
      { recursive: true },
    );
    // Create a valid skill too
    await mkdir(join(tmpDir, "source", "skills", "bundled", "good-skill"), {
      recursive: true,
    });
    await writeFile(
      join(tmpDir, "source", "skills", "bundled", "good-skill", "SKILL.md"),
      VALID_SKILL,
    );

    let stderr = "";
    let exitCode = 0;
    try {
      execFileSync("node", [scriptPath, tmpDir], { encoding: "utf-8" });
    } catch (err: any) {
      exitCode = err.status;
      stderr = err.stderr;
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain("FATAL");
    expect(stderr).toContain("broken-skill");
  });

  it("exits with code 1 when no bundled skills exist (empty directory)", async () => {
    // bundled/ exists but has no subdirectories at all
    let stderr = "";
    let exitCode = 0;
    try {
      execFileSync("node", [scriptPath, tmpDir], { encoding: "utf-8" });
    } catch (err: any) {
      exitCode = err.status;
      stderr = err.stderr;
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain("FATAL");
    expect(stderr).toContain("no bundled skills found");
  });

  it("exits with code 1 when ALL directories are missing SKILL.md", async () => {
    await mkdir(join(tmpDir, "source", "skills", "bundled", "empty-a"), {
      recursive: true,
    });
    await mkdir(join(tmpDir, "source", "skills", "bundled", "empty-b"), {
      recursive: true,
    });

    let stderr = "";
    let exitCode = 0;
    try {
      execFileSync("node", [scriptPath, tmpDir], { encoding: "utf-8" });
    } catch (err: any) {
      exitCode = err.status;
      stderr = err.stderr;
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain("FATAL");
    expect(stderr).toContain("empty-a");
    expect(stderr).toContain("empty-b");
  });

  it("names every broken directory in the FATAL message", async () => {
    await mkdir(join(tmpDir, "source", "skills", "bundled", "alpha"), {
      recursive: true,
    });
    await mkdir(join(tmpDir, "source", "skills", "bundled", "bravo"), {
      recursive: true,
    });
    await mkdir(join(tmpDir, "source", "skills", "bundled", "charlie"), {
      recursive: true,
    });
    // Only charlie has SKILL.md
    await writeFile(
      join(tmpDir, "source", "skills", "bundled", "charlie", "SKILL.md"),
      VALID_SKILL,
    );

    let stderr = "";
    let exitCode = 0;
    try {
      execFileSync("node", [scriptPath, tmpDir], { encoding: "utf-8" });
    } catch (err: any) {
      exitCode = err.status;
      stderr = err.stderr;
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain("alpha");
    expect(stderr).toContain("bravo");
    expect(stderr).not.toContain("charlie");
  });

  it("succeeds and writes manifest when all entries have SKILL.md", async () => {
    await mkdir(join(tmpDir, "source", "skills", "bundled", "skill-a"), {
      recursive: true,
    });
    await mkdir(join(tmpDir, "source", "skills", "bundled", "skill-b"), {
      recursive: true,
    });
    await writeFile(
      join(tmpDir, "source", "skills", "bundled", "skill-a", "SKILL.md"),
      VALID_SKILL,
    );
    await writeFile(
      join(tmpDir, "source", "skills", "bundled", "skill-b", "SKILL.md"),
      VALID_SKILL,
    );

    const stdout = execFileSync("node", [scriptPath, tmpDir], {
      encoding: "utf-8",
    });

    expect(stdout).toContain("wrote 2 skills");
    const manifest = await readFile(
      join(tmpDir, "source", "skills", "bundled-manifest.ts"),
      "utf-8",
    );
    expect(manifest).toContain("skill-a");
    expect(manifest).toContain("skill-b");
    expect(manifest).toContain("BUNDLED_SKILL_FILES");
  });
});
