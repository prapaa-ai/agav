import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { createDefaultAgentInvoker, type AgentInvokeRequest } from "../workflows/agent-invoker.js";
import { confirmAgentTool } from "../workflows/gated-tools.js";

// Real default invoker + real native loop + real built-in tools; only the LLM is scripted.
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "agav-wf-perm-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function scripted(calls: Array<{ name: string; input: Record<string, unknown> }>): LLMProvider {
  const turns: StreamEvent[][] = calls.map((call, i) => [
    { type: "tool_call_start", toolName: call.name, toolCallId: `c${i}` },
    { type: "tool_call_delta", toolCallId: `c${i}`, argsJson: JSON.stringify(call.input) },
  ]);
  turns.push([{ type: "text_delta", text: "done" }]);
  return { name: "mock", stream: vi.fn(() => (async function* () { for (const e of turns.shift() ?? []) yield e; })()) };
}

function run(config: Partial<AgavConfig>, calls: Array<{ name: string; input: Record<string, unknown> }>, extra: Partial<AgentInvokeRequest> = {}, confirm?: AgentInvokeRequest["confirmTool"]) {
  const full = { model: "m", maxTokens: 1000, maxIterations: 8, ...config } as AgavConfig;
  const confirmTool = confirm ?? ((name, input) => confirmAgentTool(name, input as Record<string, unknown>, full, new AbortController().signal, undefined, { nodeId: "n" }));
  return createDefaultAgentInvoker({ provider: scripted(calls), config: full }).invoke({
    systemPrompt: "sys", task: "t", signal: new AbortController().signal, cwd: dir, confirmTool,
    permissionMode: full.permissionMode, ...extra,
  });
}

describe("workflow agent sub-tool permissions (default invoker + native loop)", () => {
  it("auto-accept + prompt allowedTools write_file cannot bypass config.allowedTools [read_file]", async () => {
    const target = join(dir, "out.txt");
    await run({ permissionMode: "auto-accept", allowedTools: ["read_file"] }, [{ name: "write_file", input: { path: target, content: "x" } }], { allowedTools: ["write_file"] });
    expect(existsSync(target)).toBe(false);
  });

  it("denies even when the supplied confirm would approve everything", async () => {
    const target = join(dir, "out.txt");
    const confirm = vi.fn(async () => true);
    await run({ permissionMode: "auto-accept", allowedTools: ["read_file"] }, [{ name: "write_file", input: { path: target, content: "x" } }], { allowedTools: ["write_file"] }, confirm);
    expect(existsSync(target)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("enforces path-scoped rules: in-scope write runs, out-of-scope write does not", async () => {
    const ok = join(dir, "ok.txt"), bad = join(dir, "bad.txt");
    await run({ permissionMode: "auto-accept", allowedTools: [`write_file:${dir}/ok.*`] },
      [{ name: "write_file", input: { path: ok, content: "x" } }, { name: "write_file", input: { path: bad, content: "x" } }], { allowedTools: ["write_file"] });
    expect(existsSync(ok)).toBe(true);
    expect(existsSync(bad)).toBe(false);
  });

  it("auto-accept still refuses destructive commands without asking", async () => {
    const victim = join(dir, "victim");
    await writeFile(victim, "keep");
    const confirm = vi.fn(async () => true);
    await run({ permissionMode: "auto-accept" }, [{ name: "run_command", input: { command: `rm -rf ${dir}` } }], { allowedTools: ["run_command"] }, confirm);
    expect(existsSync(victim)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("deny-writes refuses writes", async () => {
    const target = join(dir, "out.txt");
    await run({ permissionMode: "deny-writes" }, [{ name: "write_file", input: { path: target, content: "x" } }], { allowedTools: ["write_file"] });
    expect(existsSync(target)).toBe(false);
  });

  it("auto-accept still performs a permitted write", async () => {
    const target = join(dir, "out.txt");
    await run({ permissionMode: "auto-accept" }, [{ name: "write_file", input: { path: target, content: "x" } }], { allowedTools: ["write_file"] });
    expect(existsSync(target)).toBe(true);
  });

  it("ask mode still defers to the confirm and a denial does not execute", async () => {
    const target = join(dir, "out.txt");
    const confirm = vi.fn(async () => false);
    await run({ permissionMode: "ask" }, [{ name: "write_file", input: { path: target, content: "x" } }], { allowedTools: ["write_file"] }, confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(existsSync(target)).toBe(false);
  });
});
