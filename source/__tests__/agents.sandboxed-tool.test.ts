import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSandboxedTool } from "../agents/sandboxed-tool.js";

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
});
