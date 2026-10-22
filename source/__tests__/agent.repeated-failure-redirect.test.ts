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

  it("ignores identifiable volatile fields so the same error still matches", async () => {
    // Hex addresses, timestamps and file:line:col positions differ each attempt
    // but the underlying error is the same — it should still be caught.
    const { redirects } = await scenario([
      [fail("TypeError at 0x1a2b (app.ts:10:5) 2026-01-01T00:00:00Z")],
      [fail("TypeError at 0x9f3c (app.ts:42:9) 2026-01-02T11:22:33Z")],
      [fail("TypeError at 0xdead (app.ts:7:1) 2026-02-03T04:05:06Z")],
    ]);
    expect(redirects).toHaveLength(1);
  });

  it("keeps meaningful numbers distinct (different HTTP codes are different errors)", async () => {
    // Bare numbers carry meaning: 401 vs 403 vs 503 are three different
    // failures, not one repeated three times.
    const { redirects } = await scenario([
      [fail("curl: request failed with status 401")],
      [fail("curl: request failed with status 403")],
      [fail("curl: request failed with status 503")],
    ]);
    expect(redirects).toHaveLength(0);
  });

  it("keeps the error field when a volatile timestamp precedes it (compact JSON)", async () => {
    // The ISO-timestamp rule must not greedily consume the trailing error. Three
    // responses that share a timestamp field but differ in the error are three
    // different failures.
    const { redirects } = await scenario([
      [fail('{"timestamp":"2026-10-22T03:15:30.135Z","error":"ECONNREFUSED"}')],
      [fail('{"timestamp":"2026-10-22T03:16:11.901Z","error":"EACCES"}')],
      [fail('{"timestamp":"2026-10-22T03:17:45.502Z","error":"ENOENT"}')],
    ]);
    expect(redirects).toHaveLength(0);
  });

  it("keeps the error field when a volatile temp path precedes it (compact JSON)", async () => {
    // The temp-path rule must stop at structured-data delimiters, not consume the
    // trailing error. Three responses sharing a temp path but differing in the
    // error are three different failures.
    const { redirects } = await scenario([
      [fail('{"path":"/tmp/work/config.json","error":"ENOENT"}')],
      [fail('{"path":"/tmp/work/config.json","error":"EACCES"}')],
      [fail('{"path":"/tmp/work/config.json","error":"ENOSPC"}')],
    ]);
    expect(redirects).toHaveLength(0);
  });

  it("a stale candidate does not block a valid redirect from another tool", async () => {
    // Tools A and B each fail twice. In the third batch: A fails (crosses the
    // threshold → candidate), then A succeeds (its candidate goes stale), then B
    // fails (crosses the threshold). B is still stuck and must get the redirect.
    const tools = new ToolRegistry();
    const aResults: ToolResult[] = [
      { output: "a-boom", isError: true },  // turn 1
      { output: "a-boom", isError: true },  // turn 2
      { output: "a-boom", isError: true },  // turn 3, call A1 (crosses)
      { output: "ok", isError: false },     // turn 3, call A2 (success → stale)
    ];
    const bResults: ToolResult[] = [
      { output: "b-boom", isError: true },  // turn 1
      { output: "b-boom", isError: true },  // turn 2
      { output: "b-boom", isError: true },  // turn 3, call B (crosses)
    ];
    tools.register({
      schema: { name: "tool_a", description: "mock", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ ...aResults.shift()! })),
    });
    tools.register({
      schema: { name: "tool_b", description: "mock", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ ...bResults.shift()! })),
    });
    // Turns 1-2: A and B each fail once. Turn 3: A1, A2 (success), B.
    const batches: string[][] = [
      ["tool_a", "tool_b"],
      ["tool_a", "tool_b"],
      ["tool_a", "tool_a", "tool_b"],
    ];
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
    conversation.addUserMessage("do the thing");
    for await (const _ of runAgentLoop({
      provider: { name: "mock", stream },
      conversation,
      toolRegistry: tools,
      model: "mock",
      permissionMode: "auto-accept",
      iterationsBudget: { remaining: 50, total: 50 },
    })) void _;
    const redirects = conversation.getMessages()
      .filter((m) => m.internal)
      .flatMap((m) => m.content.map((b) => b.text ?? ""))
      .filter((p) => p.startsWith(REPEATED_FAILURE_PREFIX));
    expect(redirects).toHaveLength(1);
    expect(redirects[0]).toContain("tool_b");
  });

  it("treats reordered argument keys as the same call", async () => {
    // JSON key order must not matter — otherwise alternating key order dodges
    // detection forever. Six identical failures with the keys swapped each time
    // must still redirect.
    const a = { command: "a", timeout_ms: 30000 };
    const b = { timeout_ms: 30000, command: "a" };
    const { redirects } = await scenario([
      [fail("boom", a)], [fail("boom", b)], [fail("boom", a)],
      [fail("boom", b)], [fail("boom", a)], [fail("boom", b)],
    ]);
    expect(redirects).toHaveLength(1);
  });

  it("does not inject a stale redirect when the same call later succeeds in the batch", async () => {
    // After two failures, a third turn batches a failure (crossing the threshold)
    // followed by a success for the same call. The success resets the streak, so
    // the pending redirect is stale and must not be injected.
    const tools = new ToolRegistry();
    const results: ToolResult[] = [
      { output: "boom", isError: true },   // turn 1
      { output: "boom", isError: true },   // turn 2
      { output: "boom", isError: true },   // turn 3, call 1 (crosses threshold)
      { output: "ok", isError: false },    // turn 3, call 2 (success resets)
    ];
    tools.register({
      schema: { name: "run_command", description: "mock", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ ...results.shift()! })),
    });
    // Turns 1-2: one failing call each. Turn 3: two calls (fail then succeed).
    const batches = [["0-0"], ["1-0"], ["2-0", "2-1"]];
    const streams: StreamEvent[][] = batches.map((ids) => [
      ...ids.flatMap((id): StreamEvent[] => [
        { type: "tool_call_start", toolCallId: id, toolName: "run_command" },
        { type: "tool_call_delta", toolCallId: id, argsJson: "{}" },
      ]),
      { type: "message_end", stopReason: "tool_use" },
    ]);
    const stream = vi.fn(() => (async function* () {
      for (const event of streams.shift() ?? [{ type: "message_end", stopReason: "end_turn" } as StreamEvent]) yield event;
    })());
    const conversation = new ConversationState();
    conversation.addUserMessage("do the thing");
    for await (const _ of runAgentLoop({
      provider: { name: "mock", stream },
      conversation,
      toolRegistry: tools,
      model: "mock",
      permissionMode: "auto-accept",
      iterationsBudget: { remaining: 50, total: 50 },
    })) void _;
    const prompts = conversation.getMessages().filter((m) => m.internal).flatMap((m) => m.content.map((b) => b.text ?? ""));
    expect(prompts.filter((p) => p.startsWith(REPEATED_FAILURE_PREFIX))).toHaveLength(0);
  });

  it("compares the diagnostic tail, not just leading progress output", async () => {
    // Identical build progress fills the prefix; the real error trails it. Three
    // different trailing errors must not be treated as the same failure.
    const progress = "Compiling module ".repeat(400); // ~7 KB of identical prefix
    const { redirects } = await scenario([
      [fail(progress + "error: undefined symbol 'foo'")],
      [fail(progress + "error: undefined symbol 'bar'")],
      [fail(progress + "error: undefined symbol 'baz'")],
    ]);
    expect(redirects).toHaveLength(0);
  });

  it("changing arguments mid-streak does not resurrect a stale counter", async () => {
    // A → A → B → A: the B call is a change of approach, so the A streak resets
    // and the final A is only the first failure of a new streak.
    const { redirects } = await scenario([
      [fail("boom", { command: "a" })],
      [fail("boom", { command: "a" })],
      [fail("boom", { command: "b" })],
      [fail("boom", { command: "a" })],
    ]);
    expect(redirects).toHaveLength(0);
  });

  it("re-offers a redirect suppressed by a batched test failure", async () => {
    // A command's third identical failure is batched with a failing test run on
    // the third turn, which suppresses the redirect that turn. Two more identical
    // command failures (without a test) must still deliver it.
    const tools = new ToolRegistry();
    const cmdFail: ToolResult = { output: "boom", isError: true };
    const testFail: ToolResult = {
      output: "failed",
      isError: true,
      verification: { status: "failed", passed: 0, failed: 1, errors: 0, exitCode: 1 },
    };
    tools.register({
      schema: { name: "run_command", description: "mock", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ ...cmdFail })),
    });
    tools.register({
      schema: { name: "run_tests", description: "mock", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ ...testFail })),
    });
    // Turns 1-2: command fails. Turn 3: command + failing test (suppresses).
    // Turns 4-5: command fails alone (should now deliver).
    const batches: { name: string }[][] = [
      [{ name: "run_command" }],
      [{ name: "run_command" }],
      [{ name: "run_command" }, { name: "run_tests" }],
      [{ name: "run_command" }],
      [{ name: "run_command" }],
    ];
    const streams: StreamEvent[][] = batches.map((calls, batch) => [
      ...calls.flatMap((call, index): StreamEvent[] => [
        { type: "tool_call_start", toolCallId: `${batch}-${index}`, toolName: call.name },
        { type: "tool_call_delta", toolCallId: `${batch}-${index}`, argsJson: "{}" },
      ]),
      { type: "message_end", stopReason: "tool_use" },
    ]);
    const stream = vi.fn(() => (async function* () {
      for (const event of streams.shift() ?? [{ type: "message_end", stopReason: "end_turn" } as StreamEvent]) yield event;
    })());
    const conversation = new ConversationState();
    conversation.addUserMessage("do the thing");
    for await (const _ of runAgentLoop({
      provider: { name: "mock", stream },
      conversation,
      toolRegistry: tools,
      model: "mock",
      permissionMode: "auto-accept",
      iterationsBudget: { remaining: 50, total: 50 },
    })) void _;
    const prompts = conversation.getMessages().filter((m) => m.internal).flatMap((m) => m.content.map((b) => b.text ?? ""));
    expect(prompts.filter((p) => p.startsWith(REPEATED_FAILURE_PREFIX))).toHaveLength(1);
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
