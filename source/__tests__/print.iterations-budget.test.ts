import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeMode } from "../main.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";

vi.mock("../tools/registry-factory.js", async () => {
  const { ToolRegistry } = await import("../tools/registry.js");
  return { createToolRegistry: () => {
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: "read_file", description: "Read a fixture", inputSchema: { type: "object" } },
      execute: async () => ({ output: "fixture", isError: false }),
    });
    return registry;
  } };
});

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const config: AgavConfig = {
  provider: "anthropic", model: "test", effort: "medium", maxTokens: 1024,
  maxIterations: 1, errorRetries: 1, permissionMode: "ask",
};
const text = (value: string): StreamEvent[] => [
  { type: "text_delta", text: value }, { type: "message_end", stopReason: "end_turn" },
];
const read: StreamEvent[] = [
  { type: "tool_call_start", toolCallId: "read-1", toolName: "read_file" },
  { type: "tool_call_delta", toolCallId: "read-1", argsJson: "{}" },
  { type: "message_end", stopReason: "tool_calls" },
];
function providerFor(responses: StreamEvent[][]) {
  const stream = vi.fn((_params: StreamParams) => (async function* () {
    for (const event of responses.shift() ?? text('{"ok":true}')) yield event;
  })());
  return { name: "mock", stream } satisfies LLMProvider;
}
const stdout = () => vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
const stderr = () => vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("");

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("print-mode prompt iteration budget", () => {
  it.each(['{"ok":"wrong"}', "not JSON"])("does not correct invalid output %j after the last request", async (invalid) => {
    const provider = providerFor([text(invalid), text('{"ok":true}')]);
    expect(await runPipeMode("Return a result", config, provider, { stdinContent: "", outputSchema: schema, stream: true })).toBe(1);
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(stdout()).toBe("");
    expect(stderr()).toMatch(/JSON Schema validation.*maximum iterations/);
    expect(stderr()).not.toContain("retrying once");
  });

  it("uses the remaining request for a successful correction and buffers invalid output", async () => {
    const provider = providerFor([text('{"ok":"wrong"}'), text('{"ok":true}')]);
    expect(await runPipeMode("Return a result", { ...config, maxIterations: 2 }, provider, { stdinContent: "", outputSchema: schema, stream: true })).toBe(0);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(stdout()).toBe('{"ok":true}\n');
    expect(stderr()).toContain("retrying once");
  });

  it("does not replenish the budget for a correction that needs tool follow-up", async () => {
    const provider = providerFor([text('{"ok":"wrong"}'), read, text('{"ok":true}')]);
    expect(await runPipeMode("Return a result", { ...config, maxIterations: 2 }, provider, { stdinContent: "", outputSchema: schema })).toBe(1);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("Agent reached maximum iterations");
  });

  it("still reports schema failure after one unsuccessful correction", async () => {
    const provider = providerFor([text('{"ok":"wrong"}'), text('{"ok":null}')]);
    expect(await runPipeMode("Return a result", { ...config, maxIterations: 3 }, provider, { stdinContent: "", outputSchema: schema })).toBe(1);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("JSON Schema validation after retry");
  });

  it.each([1, 2])("no-edit retries share the %i-request allowance", async (maxIterations) => {
    const provider = providerFor([text("Analysis only"), text("Still no edits")]);
    expect(await runPipeMode("Fix the fixture", { ...config, maxIterations }, provider, { stdinContent: "" })).toBe(1);
    expect(provider.stream).toHaveBeenCalledTimes(maxIterations);
    expect(stderr()).toContain("Agent reached maximum iterations");
  });

  it("accepts valid output on the last request without a retry", async () => {
    const provider = providerFor([text('{"ok":true}')]);
    expect(await runPipeMode("Return a result", config, provider, { stdinContent: "", outputSchema: schema })).toBe(0);
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(stdout()).toBe('{"ok":true}\n');
    expect(stderr()).toBe("");
  });
});
