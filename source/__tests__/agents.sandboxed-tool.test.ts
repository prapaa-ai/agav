import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import {
  executeSandboxedTool,
  AGENT_SEATBELT_PROFILE,
  getBubblewrapPrivatePaths,
  canMountTmpfs,
  parseResult,
  RESULT_DELIMITER,
  toolIsInAgav,
  isToolInAgav,
} from "../agents/sandboxed-tool.js";
import { getAgavDir } from "../config/config.js";

describe("agents/sandboxed-tool", () => {
  let toolDir: string;

  beforeEach(async () => {
    toolDir = await mkdtemp(join(tmpdir(), "agav-sandboxed-tool-test-"));
  });

  afterEach(async () => {
    await rm(toolDir, { recursive: true, force: true });
  });

  it("executes a simple tool and returns its output", async () => {
    const toolPath = join(toolDir, "echo.mjs");
    await writeFile(toolPath, [
      `export default {`,
      `  async execute(input) {`,
      `    return { output: "hello " + (input.name || "world"), isError: false };`,
      `  }`,
      `};`,
    ].join("\n"));

    const result = await executeSandboxedTool(toolPath, { name: "agav" }, undefined, "none");
    expect(result.output).toBe("hello agav");
    expect(result.isError).toBe(false);
  });

  it("returns isError: true when tool throws", async () => {
    const toolPath = join(toolDir, "fail.mjs");
    await writeFile(toolPath, [
      `export default {`,
      `  async execute() { throw new Error("kaboom"); }`,
      `};`,
    ].join("\n"));

    const result = await executeSandboxedTool(toolPath, {}, undefined, "none");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("kaboom");
  });

  it("returns error when tool file has no execute function", async () => {
    const toolPath = join(toolDir, "no-exec.mjs");
    await writeFile(toolPath, `export default { schema: { name: "bad" } };`);

    const result = await executeSandboxedTool(toolPath, {}, undefined, "none");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no execute function");
  });

  it("does NOT set globalThis in the parent process", async () => {
    const key = "__agavSandboxIsolationTest";
    delete (globalThis as any)[key];

    const toolPath = join(toolDir, "side-effect.mjs");
    await writeFile(toolPath, [
      `globalThis.${key} = true;`,
      `export default {`,
      `  async execute() { return { output: "done", isError: false }; }`,
      `};`,
    ].join("\n"));

    const result = await executeSandboxedTool(toolPath, {}, undefined, "none");
    expect(result.output).toBe("done");
    expect(result.isError).toBe(false);
    // The side effect should NOT have leaked into this process
    expect((globalThis as any)[key]).toBeUndefined();
  });

  it("passes credentials as env vars to the subprocess", async () => {
    const toolPath = join(toolDir, "read-env.mjs");
    await writeFile(toolPath, [
      `export default {`,
      `  async execute() {`,
      `    return { output: process.env.MY_SECRET || "missing", isError: false };`,
      `  }`,
      `};`,
    ].join("\n"));

    const result = await executeSandboxedTool(
      toolPath,
      {},
      { MY_SECRET: "s3cr3t" },
      "none",
    );
    expect(result.output).toBe("s3cr3t");
    expect(result.isError).toBe(false);
  });

  it("strips host secrets from subprocess env", async () => {
    // Temporarily set a secret in the parent env
    const origKey = process.env.AGAV_TEST_API_KEY;
    process.env.AGAV_TEST_API_KEY = "should-be-stripped";

    try {
      const toolPath = join(toolDir, "leak-check.mjs");
      await writeFile(toolPath, [
        `export default {`,
        `  async execute() {`,
        `    return { output: process.env.AGAV_TEST_API_KEY || "stripped", isError: false };`,
        `  }`,
        `};`,
      ].join("\n"));

      const result = await executeSandboxedTool(toolPath, {}, undefined, "none");
      // The env var name contains "KEY" so filterEnv should strip it
      expect(result.output).toBe("stripped");
    } finally {
      if (origKey === undefined) delete process.env.AGAV_TEST_API_KEY;
      else process.env.AGAV_TEST_API_KEY = origKey;
    }
  });

  it("handles tool that reads input correctly", async () => {
    const toolPath = join(toolDir, "echo-input.mjs");
    await writeFile(toolPath, [
      `export default {`,
      `  async execute(input) {`,
      `    return { output: JSON.stringify(input), isError: false };`,
      `  }`,
      `};`,
    ].join("\n"));

    const result = await executeSandboxedTool(
      toolPath,
      { query: "test query", count: 42 },
      undefined,
      "none",
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.query).toBe("test query");
    expect(parsed.count).toBe(42);
    expect(result.isError).toBe(false);
  });

  it("reports the sandbox backend used", async () => {
    const toolPath = join(toolDir, "noop.mjs");
    await writeFile(toolPath, [
      `export default {`,
      `  async execute() { return { output: "ok", isError: false }; }`,
      `};`,
    ].join("\n"));

    const result = await executeSandboxedTool(toolPath, {}, undefined, "none");
    expect(result.backend).toBe("none");
  });

  it("includes AGAV_DIR deny rule, TOOL_DIR allow rule, and config.json deny rules in Apple Seatbelt profile", () => {
    expect(AGENT_SEATBELT_PROFILE).toContain('(deny file-read* (subpath (param "AGAV_DIR")))');
    expect(AGENT_SEATBELT_PROFILE).toContain('(allow file-read* (subpath (param "TOOL_DIR")))');
    expect(AGENT_SEATBELT_PROFILE).toContain('(deny file-read* (regex #"[/\\]config\\.json$"))');
    expect(AGENT_SEATBELT_PROFILE).toContain('(deny file-read* (subpath (param "HOME_SSH")))');
    expect(AGENT_SEATBELT_PROFILE).toContain('(deny file-read* (subpath (param "HOME_AWS")))');
    expect(AGENT_SEATBELT_PROFILE).toContain('(deny file-read* (subpath (param "HOME_GPG")))');

    const denyIndex = AGENT_SEATBELT_PROFILE.indexOf('(deny file-read* (subpath (param "AGAV_DIR")))');
    const allowIndex = AGENT_SEATBELT_PROFILE.indexOf('(allow file-read* (subpath (param "TOOL_DIR")))');
    const denyConfigIndex = AGENT_SEATBELT_PROFILE.indexOf('(deny file-read* (regex #"[/\\]config\\.json$"))');
    expect(allowIndex).toBeGreaterThan(denyIndex);
    expect(denyConfigIndex).toBeGreaterThan(allowIndex);
  });

  it("includes getAgavDir() in Linux Bubblewrap privateHomePaths", () => {
    const paths = getBubblewrapPrivatePaths();
    expect(paths).toContain(getAgavDir());
  });

  it("separates tool result protocol from arbitrary stdout logs", async () => {
    const toolPath = join(toolDir, "noisy-tool.mjs");
    await writeFile(toolPath, [
      `export default {`,
      `  async execute(input) {`,
      `    console.log("Random debug log from tool");`,
      `    console.log("{ not actual result json }");`,
      `    process.stdout.write("Direct stdout write without newline: ");`,
      `    return { output: "clean execution result", isError: false };`,
      `  }`,
      `};`,
    ].join("\n"));

    const result = await executeSandboxedTool(toolPath, {}, undefined, "none");
    expect(result.output).toBe("clean execution result");
    expect(result.isError).toBe(false);
  });

  it("parseResult ignores noisy stdout before delimiter", () => {
    const noisyStdout = [
      "Starting external tool...",
      "info: fetching resources",
      "{ broken: json [",
      `\n${RESULT_DELIMITER}\n`,
      JSON.stringify({ output: "parsed payload", isError: false }),
      "\n",
    ].join("\n");

    const result = parseResult({
      stdout: noisyStdout,
      stderr: "",
      error: null,
    });
    expect(result.output).toBe("parsed payload");
    expect(result.isError).toBe(false);
  });

  it("preserves isError: true when process error is provided even if payload parses with isError: false", () => {
    // Delimiter case
    const delimiterStdout = [
      "Starting external tool...",
      `\n${RESULT_DELIMITER}\n`,
      JSON.stringify({ output: "payload result", isError: false }),
    ].join("\n");

    const resultWithDelimiter = parseResult({
      stdout: delimiterStdout,
      stderr: "Process timeout",
      error: new Error("Process timeout"),
    });
    expect(resultWithDelimiter.output).toBe("payload result");
    expect(resultWithDelimiter.isError).toBe(true);

    // Direct JSON fallback case
    const directStdout = JSON.stringify({ output: "direct result", isError: false });
    const resultDirect = parseResult({
      stdout: directStdout,
      stderr: "Non-zero exit",
      error: new Error("Non-zero exit"),
    });
    expect(resultDirect.output).toBe("direct result");
    expect(resultDirect.isError).toBe(true);
  });

  it("matches framed delimiter when stdout logs or tool output contain RESULT_DELIMITER", () => {
    const payloadWithDelimiter = {
      output: `Result payload containing ${RESULT_DELIMITER} inside`,
      isError: false,
    };
    const noisyStdout = [
      `Processing token ${RESULT_DELIMITER} in logs without leading/trailing newline frame`,
      `\n${RESULT_DELIMITER}\n`,
      JSON.stringify(payloadWithDelimiter),
      "\n",
    ].join("\n");

    const result = parseResult({
      stdout: noisyStdout,
      stderr: "",
      error: null,
    });
    expect(result.output).toBe(`Result payload containing ${RESULT_DELIMITER} inside`);
    expect(result.isError).toBe(false);
  });

  it("matches CRLF-framed delimiter when CRLF line endings are used", () => {
    const crlfStdout = `Some prior logs\r\n${RESULT_DELIMITER}\r\n${JSON.stringify({
      output: `CRLF output with ${RESULT_DELIMITER}`,
      isError: false,
    })}\r\n`;

    const result = parseResult({
      stdout: crlfStdout,
      stderr: "",
      error: null,
    });
    expect(result.output).toBe(`CRLF output with ${RESULT_DELIMITER}`);
    expect(result.isError).toBe(false);
  });

  it("executes a tool whose returned output contains RESULT_DELIMITER end-to-end", async () => {
    const toolPath = join(toolDir, "delimiter-in-output.mjs");
    await writeFile(toolPath, [
      `export default {`,
      `  async execute() {`,
      `    console.log("Unframed log mentioning __AGAV_RESULT__ here");`,
      `    return { output: "Output containing __AGAV_RESULT__ token", isError: false };`,
      `  }`,
      `};`,
    ].join("\n"));

    const result = await executeSandboxedTool(toolPath, {}, undefined, "none");
    expect(result.output).toBe("Output containing __AGAV_RESULT__ token");
    expect(result.isError).toBe(false);
  });

  it("canonicalizes symlinked private directories and includes both symlink and canonical target in getBubblewrapPrivatePaths", async () => {
    const fakeHome = join(toolDir, "fake-home");
    const realSshDir = join(toolDir, "real-ssh-target");
    await mkdir(fakeHome, { recursive: true });
    await mkdir(realSshDir, { recursive: true });

    const symlinkPath = join(fakeHome, ".ssh");
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(realSshDir, symlinkPath, symlinkType);

    const paths = getBubblewrapPrivatePaths(fakeHome);

    // Both the symlink path and the canonical real directory path should be present
    expect(paths).toContain(symlinkPath);
    const canonicalReal = realpathSync(realSshDir);
    expect(paths).toContain(canonicalReal);

    // canMountTmpfs should return true for both the symlink pointing to a directory and the real directory
    expect(canMountTmpfs(symlinkPath)).toBe(true);
    expect(canMountTmpfs(canonicalReal)).toBe(true);
  });

  it("canMountTmpfs returns true for directories and directory symlinks, and false for files or missing paths", async () => {
    const testDir = join(toolDir, "test-dir");
    const testFile = join(toolDir, "test-file.txt");
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, "hello");

    const symlinkPath = join(toolDir, "symlink-dir");
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(testDir, symlinkPath, symlinkType);

    expect(canMountTmpfs(testDir)).toBe(true);
    expect(canMountTmpfs(symlinkPath)).toBe(true);
    expect(canMountTmpfs(testFile)).toBe(false);
    expect(canMountTmpfs(join(toolDir, "nonexistent"))).toBe(false);
  });

  it("verifies that toolIsInAgav evaluates to true for paths under canonical or symlinked Agav roots and false for paths outside", async () => {
    // 1. Canonical default Agav root
    const toolUnderDefaultAgav = join(getAgavDir(), "agents", "jira", "tools", "jira.mjs");
    expect(toolIsInAgav(toolUnderDefaultAgav)).toBe(true);
    expect(toolIsInAgav(join(getAgavDir(), "root-tool.mjs"))).toBe(true);

    // 2. Paths outside Agav root
    expect(toolIsInAgav("/other/path/not-agav")).toBe(false);
    expect(toolIsInAgav("/other/path/not-agav/tool.mjs")).toBe(false);
    expect(toolIsInAgav(join(toolDir, "outside", "tool.mjs"))).toBe(false);

    // 3. Prefix boundary collision protection
    expect(toolIsInAgav(`${getAgavDir()}-evil/tool.mjs`)).toBe(false);

    // 4. Canonical and symlinked Agav roots
    const realAgavDir = join(toolDir, "canonical-agav");
    const symlinkedAgavDir = join(toolDir, "symlinked-agav");
    await mkdir(join(realAgavDir, "tools"), { recursive: true });

    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(realAgavDir, symlinkedAgavDir, symlinkType);

    // Direct inline check matching runBubblewrapped implementation
    const checkToolIsInAgav = (toolPath: string, rootDir: string) => {
      const targetToolDir = dirname(resolve(toolPath));
      const agavRoots = [resolve(rootDir)];
      try {
        agavRoots.push(realpathSync(rootDir));
      } catch {}
      return Array.from(new Set(agavRoots)).some(
        (root) =>
          targetToolDir === root ||
          targetToolDir.startsWith(`${root}/`) ||
          targetToolDir.startsWith(`${root}\\`),
      );
    };

    const toolInReal = join(realAgavDir, "tools", "tool.mjs");
    const toolInSymlink = join(symlinkedAgavDir, "tools", "tool.mjs");
    const toolOutside = "/other/path/not-agav/tool.mjs";
    const toolEvilSibling = `${realAgavDir}-evil/tool.mjs`;

    // Evaluates to true under canonical root when Agav root is symlinked
    expect(checkToolIsInAgav(toolInReal, symlinkedAgavDir)).toBe(true);
    expect(toolIsInAgav(toolInReal, symlinkedAgavDir)).toBe(true);

    // Evaluates to true under symlinked root when Agav root is symlinked
    expect(checkToolIsInAgav(toolInSymlink, symlinkedAgavDir)).toBe(true);
    expect(toolIsInAgav(toolInSymlink, symlinkedAgavDir)).toBe(true);

    // Evaluates to false for paths outside
    expect(checkToolIsInAgav(toolOutside, symlinkedAgavDir)).toBe(false);
    expect(checkToolIsInAgav("/other/path/not-agav", symlinkedAgavDir)).toBe(false);
    expect(toolIsInAgav(toolOutside, symlinkedAgavDir)).toBe(false);
    expect(toolIsInAgav("/other/path/not-agav", symlinkedAgavDir)).toBe(false);

    // Evaluates to false for prefix collisions
    expect(checkToolIsInAgav(toolEvilSibling, symlinkedAgavDir)).toBe(false);
    expect(toolIsInAgav(toolEvilSibling, symlinkedAgavDir)).toBe(false);
  });
});


