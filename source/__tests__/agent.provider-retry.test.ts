import { afterEach, describe, expect, it, vi } from "vitest";
import { runPipeMode } from "../main.js";

import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { RetryProvider } from "../providers/retry.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";

afterEach(() => vi.restoreAllMocks());

const transient = (status = 429) => Object.assign(new Error("Rate limited/overloaded"), {
  status, headers: { "retry-after": "0" },
});

function setup(inner: LLMProvider, retries = 1, signal?: AbortSignal) {
  const conversation = new ConversationState();
  conversation.addUserMessage("Hello");
  const toolRegistry = new ToolRegistry();
  const budget = { remaining: 1, total: 1 };
  const loop = runAgentLoop({
    provider: new RetryProvider(inner, retries), conversation, toolRegistry,
    model: "test-model", iterationsBudget: budget, signal,
  });
  return { loop, conversation, toolRegistry, budget };
}

async function collect(loop: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of loop) events.push(event);
  return events;
}

describe("RetryProvider through the real agent loop", () => {
  it.each([429, 529])("recovers from HTTP %i without a terminal error or a second iteration", async (status) => {
    let calls = 0;
    const inner: LLMProvider = { name: "mock", stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
      calls++;
      yield { type: "message_start" };
      yield { type: "usage", inputTokens: 2, outputTokens: 0 };
      if (calls === 1) throw transient(status);
      yield { type: "text_delta", text: "SUCCESS" };
      yield { type: "message_end", stopReason: "end_turn" };
    }) };
    const { loop, conversation, budget } = setup(inner);
    const events = await collect(loop);
    expect(inner.stream).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === "error")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "retry" }));
    expect(events.filter(event => event.type === "usage")).toHaveLength(2);
    expect(events).toContainEqual({ type: "assistant_message_complete", text: "SUCCESS" });
    expect(events.at(-1)).toEqual({ type: "turn_complete" });
    expect(conversation.getMessages().at(-1)?.content).toEqual([{ type: "text", text: "SUCCESS" }]);
    expect(budget.remaining).toBe(0);
  });

  it.each([[429, 2, 3], [400, 2, 1], [429, 0, 1]])(
    "terminates HTTP %i with %i retries after %i calls", async (status, retries, calls) => {
      const error = transient(status);
      const inner: LLMProvider = { name: "mock", stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> { throw error; }) };
      const events = await collect(setup(inner, retries).loop);
      expect(inner.stream).toHaveBeenCalledTimes(calls);
      expect(events.filter(event => event.type === "error")).toEqual([{ type: "error", error }]);
      expect(events.some(event => event.type === "turn_complete")).toBe(false);
    },
  );

  it("cancels backoff without another request or successful completion", async () => {
    const controller = new AbortController();
    const inner: LLMProvider = { name: "mock", stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
      throw Object.assign(new Error("Rate limited"), { status: 429, headers: { "retry-after": "60" } });
    }) };
    const { loop } = setup(inner, 2, controller.signal);
    expect((await loop.next()).value).toMatchObject({ type: "retry" });
    const pending = loop.next();
    controller.abort();
    expect((await pending).value).toMatchObject({ type: "error" });
    expect((await loop.next()).done).toBe(true);
    expect(inner.stream).toHaveBeenCalledTimes(1);
  });

  it.each<StreamEvent>([
    { type: "text_delta", text: "partial" },
    { type: "thinking_delta", text: "partial thought" },
    { type: "tool_call_start", toolCallId: "partial", toolName: "read_file" },
    { type: "tool_call_delta", toolCallId: "partial", argsJson: "{" },
    { type: "tool_call_end", toolCallId: "partial" },
    { type: "message_end", stopReason: "end_turn" },
  ])("does not replay a failed stream after $type", async (partial) => {
    const error = transient();
    const inner: LLMProvider = { name: "mock", stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
      yield partial;
      throw error;
    }) };
    const { loop, conversation, toolRegistry } = setup(inner);
    const execute = vi.fn(async () => ({ output: "read", isError: false }));
    toolRegistry.register({ schema: { name: "read_file", description: "read", inputSchema: { type: "object" } }, execute });
    const events = await collect(loop);
    expect(inner.stream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ type: "error", error });
    expect(events.some(event => event.type === "turn_complete")).toBe(false);
    expect(events.some(event => event.type === "assistant_message_complete")).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(conversation.getMessages().some(message => message.role === "assistant")).toBe(false);
  });
});

describe("headless retry output", () => {
  it.each([false, true])("reports retries on stderr while preserving successful stdout (stream=%s)", async (stream) => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let calls = 0;
    const inner: LLMProvider = { name: "mock", async *stream() {
      if (++calls === 1) throw transient();
      yield { type: "text_delta", text: "SUCCESS" };
      yield { type: "message_end", stopReason: "end_turn" };
    } };
    expect(await runPipeMode("Hello", {
      provider: "anthropic", model: "test", effort: "low", maxTokens: 100,
      maxIterations: 1, errorRetries: 1, permissionMode: "auto-accept",
    }, new RetryProvider(inner, 1), { stdinContent: "", stream })).toBe(0);
    expect(calls).toBe(2);
    expect(vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("")).toBe("SUCCESS\n");
    expect(vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("Retrying");
  });
});
