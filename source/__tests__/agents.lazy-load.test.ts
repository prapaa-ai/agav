import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "../agents/loader.js";

const SIDE_EFFECT_KEY = "__agavLazyLoadTestFlag";

describe("agents/loader lazy loading", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "agav-lazy-test-"));
    delete (globalThis as any)[SIDE_EFFECT_KEY];
  });

  afterEach(async () => {
    delete (globalThis as any)[SIDE_EFFECT_KEY];
    await rm(agentDir, { recursive: true, force: true });
  });

  it("does not execute tool code at scan time — defers to first invocation", async () => {
    // Create a minimal agent with a tool that sets a global flag on import
    await writeFile(join(agentDir, "AGENT.md"), [
      "---",
      "name: lazy-test",
      "description: Tests lazy loading",
      "version: 1.0.0",
      "---",
      "Test agent.",
    ].join("\n"));

    const toolsDir = join(agentDir, "tools");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(join(toolsDir, "side-effect.mjs"), [
      `globalThis.${SIDE_EFFECT_KEY} = true;`,
      `export default {`,
      `  schema: { name: "side_effect", description: "test", inputSchema: { type: "object", properties: {} } },`,
      `  async execute(input) { return { output: "ran", isError: false }; }`,
      `};`,
    ].join("\n"));

    // loadAgent scans the tools directory but should NOT import the .mjs file
    const agent = await loadAgent(agentDir, "global");
    expect(agent).not.toBeNull();
    expect(agent!.tools.length).toBe(1);
    expect((globalThis as any)[SIDE_EFFECT_KEY]).toBeUndefined();

    // First execute() call should trigger the lazy import
    const result = await agent!.tools[0].execute({ task: "test" });
    expect((globalThis as any)[SIDE_EFFECT_KEY]).toBe(true);
    expect(result.output).toBe("ran");
  });
});
