import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import { REPEATED_FAILURE_PREFIX, TESTS_FAILED_PREFIX } from "../agent/internal-prompts.js";
import type { StreamEvent, LLMProvider } from "../providers/types.js";
import type { ToolResult } from "../tools/types.js";

// Each call describes one tool invocation in one batch; the result is returned
// in the order the batches queue it. Mirrors the harness in
// structured-test-verification.test.ts but lets each call carry its own result
// so we can drive distinct error strings per attempt.
type Call = { name: string; input?: Record<string, unknown>; result: ToolResult };

function fail(output: string, input?: Record<string, unknown>): Call {
  return { name: "run_command", input: input ?? { command: "do-thing" }, result: { output, isError: true } };
}
function pass(output = "ok", input?: Record<string, unknown>): Call {
  return { name: "run_command", input: input ?? { command: "do-thing" }, result: { output, isError: false } };
}

async function scenario(batches: Call[][]) {
  const tools = new ToolRegistry();
  const queues = new Map<string, ToolResult[]>();
  for (const call of batches.flat()) {
    const queue = queues.get(call.name) ?? [];
    queue.push(call.result);
    queues.set(call.name, queue);
  }
  const registered = new Set<string>();
  for (const call of batches.flat()) {
    if (registered.has(call.name)) continue;
    registered.add(call.name);
    tools.register({
      schema: { name: call.name, description: "mock", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ ...queues.get(call.name)!.shift()! })),
    });
  }

  const streams: StreamEvent[][] = batches.map((calls, batch) => [
    ...calls.flatMap((call, index): StreamEvent[] => [
      { type: "tool_call_start", toolCallId: `${batch}-${index}`, toolName: call.name },
      { type: "tool_call_delta", toolCallId: `${batch}-${index}`, argsJson: JSON.stringify(call.input ?? {}) },
    ]),
    { type: "message_end", stopReason: "tool_use" },
  ]);
  const stream = vi.fn(() => (async function* () {
    for (const event of streams.shift() ?? [{ type: "message_end", stopReason: "end_turn" } as StreamEvent]) yield event;
  })());
  const provider: LLMProvider = { name: "mock", stream };

  const conversation = new ConversationState();
  conversation.addUserMessage("do the thing");
  for await (const _ of runAgentLoop({
    provider,
    conversation,
    toolRegistry: tools,
    model: "mock",
    permissionMode: "auto-accept",
    iterationsBudget: { remaining: 50, total: 50 },
  })) void _;

  const prompts = conversation
    .getMessages()
    .filter((m) => m.internal)
    .flatMap((m) => m.content.map((b) => b.text ?? ""));
  const redirects = prompts.filter((p) => p.startsWith(REPEATED_FAILURE_PREFIX));
  return { prompts, redirects };
}

beforeEach(() => vi.resetAllMocks());

describe("repeated-failure redirect", () => {
  it("injects one redirect after three identical consecutive failures", async () => {
    const { redirects } = await scenario([[fail("boom")], [fail("boom")], [fail("boom")]]);
    expect(redirects).toHaveLength(1);
    expect(redirects[0]).toContain("run_command");
  });

  it("does not redirect before the threshold", async () => {
    const { redirects } = await scenario([[fail("boom")], [fail("boom")]]);
    expect(redirects).toHaveLength(0);
  });

  it("redirects only once even if the failure keeps repeating", async () => {
    const { redirects } = await scenario([
      [fail("boom")], [fail("boom")], [fail("boom")], [fail("boom")], [fail("boom")],
    ]);
    expect(redirects).toHaveLength(1);
  });

  it("treats a changed error as progress and restarts the streak", async () => {
    // Two of error A, then error B, then two of B: neither reaches three in a row.
    const { redirects } = await scenario([
      [fail("error A")], [fail("error A")], [fail("error B")], [fail("error B")],
    ]);
    expect(redirects).toHaveLength(0);
  });

  it("ignores volatile substrings so the same error still matches", async () => {
    // Line numbers, hex addresses and timestamps differ each attempt but the
    // underlying error is the same — it should still be caught.
    const { redirects } = await scenario([
      [fail("TypeError at 0x1a2b line 10 2026-01-01T00:00:00Z")],
      [fail("TypeError at 0x9f3c line 42 2026-01-02T11:22:33Z")],
      [fail("TypeError at 0xdead line 7 2026-02-03T04:05:06Z")],
    ]);
    expect(redirects).toHaveLength(1);
  });

  it("resets the streak after a success for the same call", async () => {
    const { redirects } = await scenario([
      [fail("boom")], [fail("boom")], [pass()], [fail("boom")], [fail("boom")],
    ]);
    expect(redirects).toHaveLength(0);
  });

  it("keys on arguments so a different command is a separate streak", async () => {
    const { redirects } = await scenario([
      [fail("boom", { command: "a" })],
      [fail("boom", { command: "b" })],
      [fail("boom", { command: "a" })],
    ]);
    expect(redirects).toHaveLength(0);
  });

  it("catches three identical failures batched in a single turn", async () => {
    const { redirects } = await scenario([[fail("boom"), fail("boom"), fail("boom")]]);
    expect(redirects).toHaveLength(1);
  });

  it("does not stack on top of the test-repair prompt for a stuck test", async () => {
    const tools = new ToolRegistry();
    const testFail: ToolResult = {
      output: "failed",
      isError: true,
      verification: { status: "failed", passed: 0, failed: 1, errors: 0, exitCode: 1 },
    };
    tools.register({
      schema: { name: "run_tests", description: "mock", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ ...testFail })),
    });
    const batches = [["run_tests"], ["run_tests"], ["run_tests"]];
    const streams: StreamEvent[][] = batches.map((names, batch) => [
      ...names.flatMap((name, index): StreamEvent[] => [
        { type: "tool_call_start", toolCallId: `${batch}-${index}`, toolName: name },
        { type: "tool_call_delta", toolCallId: `${batch}-${index}`, argsJson: "{}" },
      ]),
      { type: "message_end", stopReason: "tool_use" },
    ]);
    const stream = vi.fn(() => (async function* () {
      for (const event of streams.shift() ?? [{ type: "message_end", stopReason: "end_turn" } as StreamEvent]) yield event;
    })());
    const conversation = new ConversationState();
    conversation.addUserMessage("fix the test");
    for await (const _ of runAgentLoop({
      provider: { name: "mock", stream },
      conversation,
      toolRegistry: tools,
      model: "mock",
      permissionMode: "auto-accept",
      iterationsBudget: { remaining: 50, total: 50 },
    })) void _;
    const prompts = conversation.getMessages().filter((m) => m.internal).flatMap((m) => m.content.map((b) => b.text ?? ""));
    // The test-repair path owns stuck test runs; the generic redirect stays out.
    expect(prompts.filter((p) => p.startsWith(REPEATED_FAILURE_PREFIX))).toHaveLength(0);
    expect(prompts.filter((p) => p.startsWith(TESTS_FAILED_PREFIX)).length).toBeGreaterThan(0);
  });
});
