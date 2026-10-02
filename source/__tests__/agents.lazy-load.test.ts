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

  it("does not execute tool code at scan time — defers to first invocation (bundled)", async () => {
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

    // Bundled agents run in-process (trusted) — verify lazy loading
    const agent = await loadAgent(agentDir, "bundled");
    expect(agent).not.toBeNull();
    expect(agent!.tools.length).toBe(1);
    expect((globalThis as any)[SIDE_EFFECT_KEY]).toBeUndefined();

    // First execute() call should trigger the lazy import
    const result = await agent!.tools[0].execute({ task: "test" });
    expect((globalThis as any)[SIDE_EFFECT_KEY]).toBe(true);
    expect(result.output).toBe("ran");
  });

  it.each(["bundled", "global"] as const)("forwards cancellation through the lazy %s wrapper", async (origin) => {
    await writeFile(join(agentDir, "AGENT.md"), "---\nname: cancellation-test\ndescription: test\nversion: 1.0.0\n---\ntest");
    await mkdir(join(agentDir, "tools"));
    await writeFile(join(agentDir, "tools", "slow.schema.json"), JSON.stringify({ name: "slow", description: "test", inputSchema: { type: "object", properties: {} } }));
    await writeFile(join(agentDir, "tools", "slow.mjs"), `export default { async execute(input, context) { return { output: String(context?.signal?.aborted), isError: false }; } };`);
    const agent = await loadAgent(agentDir, origin);
    const controller = new AbortController();
    controller.abort();
    const result = await agent!.tools[0]!.execute({}, { signal: controller.signal });
    expect(result.output).toBe(origin === "bundled" ? "true" : "Tool cancelled.");
  });

  it("non-bundled agents execute tools in a sandboxed subprocess — no in-process side effects", async () => {
    await writeFile(join(agentDir, "AGENT.md"), [
      "---",
      "name: sandbox-test",
      "description: Tests sandboxed execution",
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

    // Global-origin agents run in a sandboxed subprocess
    const agent = await loadAgent(agentDir, "global");
    expect(agent).not.toBeNull();
    expect(agent!.tools.length).toBe(1);

    // Execute the tool — it runs in a subprocess, so no globalThis side effect
    const result = await agent!.tools[0].execute({ task: "test" });
    expect((globalThis as any)[SIDE_EFFECT_KEY]).toBeUndefined();
    expect(result.output).toBe("ran");
    expect(result.isError).toBe(false);
  });
});
