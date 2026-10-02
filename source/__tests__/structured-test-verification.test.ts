import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { runAgentLoop } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import { testRunnerTool } from "../tools/test-runner.js";
import { NEEDS_VERIFY_PROMPT, VERIFY_FAILED_PROMPT, TESTS_FAILED_PREFIX } from "../agent/internal-prompts.js";
import type { StreamEvent, LLMProvider } from "../providers/types.js";
import type { ToolResult } from "../tools/types.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
function childOutput(stdout: string, err: Error | null = null, stderr = "") {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void)(err, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
}
const ok: ToolResult = { output: "ok", isError: false };
const passing: ToolResult = { ...ok, verification: { status: "passed", passed: 2, failed: 0, errors: 0, exitCode: 0 } };
const inconclusive: ToolResult = { ...ok, verification: { status: "inconclusive", passed: 0, failed: 0, errors: 0, exitCode: 0 } };
const failing: ToolResult = { output: "failed", isError: true, verification: { status: "failed", passed: 0, failed: 1, errors: 0, exitCode: 1 } };
type Call = { name: string; result?: ToolResult; input?: Record<string, unknown>; builtin?: boolean };
const edit = (result = ok): Call => ({ name: "edit_file", result });
const check = (result = passing): Call => ({ name: "run_tests", result });
const shell = (isError = false): Call => ({ name: "run_command", input: { command: "pnpm test" }, result: { output: "shell", isError } });
async function scenario(batches: Call[][], permissionMode: "auto-accept" | "deny-writes" = "auto-accept", hooks?: { afterEdit?: string; afterShell?: string }) {
  const tools = new ToolRegistry();
  const queues = new Map<string, Call[]>();
  for (const call of batches.flat()) {
    const queue = queues.get(call.name) ?? [];
    queue.push(call);
    queues.set(call.name, queue);
    tools.register({ schema: { name: call.name, description: "mock", inputSchema: { type: "object", properties: {} } }, execute: vi.fn(async (input) => {
      const next = queues.get(call.name)!.shift()!;
      return next.builtin ? testRunnerTool.execute(input) : { ...next.result! };
    }) });
  }
  const streams: StreamEvent[][] = batches.map((calls, batch) => [
    ...calls.flatMap((call, index): StreamEvent[] => [
      { type: "tool_call_start", toolCallId: `${batch}-${index}`, toolName: call.name },
      { type: "tool_call_delta", toolCallId: `${batch}-${index}`, argsJson: JSON.stringify(call.input ?? {}) },
    ]), { type: "message_end", stopReason: "tool_use" },
  ]);
  const stream = vi.fn(() => (async function* () {
    for (const event of streams.shift() ?? [{ type: "message_end", stopReason: "end_turn" } as StreamEvent]) yield event;
  })());
  const provider: LLMProvider = { name: "mock", stream };
  const conversation = new ConversationState();
  conversation.addUserMessage("Fix the bug");
  const events = [];
  for await (const event of runAgentLoop({ provider, conversation, toolRegistry: tools, model: "mock", permissionMode, hooks })) events.push(event);
  const prompts = conversation.getMessages().filter((m) => m.internal).flatMap((m) => m.content.map((b) => b.text ?? ""));
  return { requests: stream.mock.calls.length, prompts, events, tools };
}
beforeEach(() => vi.resetAllMocks());

describe("structured verification loop", () => {
  it("finishes edit + passing run_tests in 3 requests, not 5", async () => {
    const result = await scenario([[edit()], [check()]]);
    expect(result.requests).toBe(3);
    expect(result.prompts).toEqual([]);
  });
  it.each([ok, inconclusive, { output: "Passed: 10 | Failed: 0", isError: false }])("does not credit missing/inconclusive metadata or output text", async (result) => {
    expect((await scenario([[edit()], [check(result)]])).requests).toBe(5);
  });
  it.each([shell(), check()])("failed tests invalidate prior verification", async (prior) => {
    const result = await scenario([[edit()], [prior], [check(failing)]]);
    expect(result.prompts.filter((p) => p === VERIFY_FAILED_PROMPT)).toHaveLength(2);
    expect(result.prompts.some((p) => p.startsWith(TESTS_FAILED_PREFIX))).toBe(true);
  });
  it("inconclusive tests do not overwrite failed state", async () => {
    const result = await scenario([[edit()], [check(failing)], [check(inconclusive)]]);
    expect(result.prompts.filter((p) => p === VERIFY_FAILED_PROMPT)).toHaveLength(2);
  });
  it.each([true, false])("parallel edits cannot be verified in either order (%s)", async (editFirst) => {
    for (const verification of [check(), shell()]) {
      const batch = editFirst ? [edit(), verification] : [verification, edit()];
      expect((await scenario([batch])).prompts).toEqual([NEEDS_VERIFY_PROMPT, NEEDS_VERIFY_PROMPT]);
    }
  });
  it.each([true, false])("failure wins across checks in either order (%s)", async (failureFirst) => {
    for (const [failure, success] of [[shell(true), check()], [check(failing), shell()], [check(failing), check()], [shell(true), shell()]]) {
      const batch = failureFirst ? [failure!, success!] : [success!, failure!];
      const result = await scenario([[edit()], batch]);
      expect(result.prompts.filter((p) => p === VERIFY_FAILED_PROMPT)).toHaveLength(2);
    }
  });
  it("later passing batch can reverify", async () => {
    const result = await scenario([[edit()], [check(failing), shell()], [check()]]);
    expect(result.requests).toBe(4);
    expect(result.prompts).not.toContain(VERIFY_FAILED_PROMPT);
  });
  it("new edits invalidate prior verification", async () => {
    expect((await scenario([[edit()], [check()], [edit()]])).prompts).toEqual([NEEDS_VERIFY_PROMPT, NEEDS_VERIFY_PROMPT]);
  });
  it("failed edits alone do not trigger verification or invalidate old success", async () => {
    const failedEdit = edit({ output: "not found", isError: true });
    expect((await scenario([[failedEdit]])).requests).toBe(2);
    expect((await scenario([[edit()], [shell()], [failedEdit]])).requests).toBe(4);
    expect((await scenario([[failedEdit, check()]])).requests).toBe(2);
  });
  it("preserves shell verification and read-only behavior", async () => {
    expect((await scenario([[edit()], [shell()]])).requests).toBe(3);
    expect((await scenario([[{ name: "read_file", result: ok }]])).requests).toBe(2);
  });
  it("does not change permission behavior", async () => {
    const result = await scenario([[edit()], [check()]], "deny-writes");
    expect(result.requests).toBe(3);
    expect(result.events.some((e) => e.type === "tool_result" && e.isError)).toBe(true);
  });
  it("preserves hooks without letting hook output verify an edit", async () => {
    childOutput("hook ok");
    const result = await scenario([[edit()], [shell()]], "auto-accept", { afterEdit: "echo edit", afterShell: "echo shell" });
    expect(result.requests).toBe(3);
    const outputs = result.events.filter((e) => e.type === "tool_result").map((e) => e.output);
    expect(outputs.every((output) => output.includes("[Hook output]: hook ok"))).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect((await scenario([[edit()]], "auto-accept", { afterEdit: "echo edit" })).requests).toBe(4);
  });
  it("write_file follows the same edit invalidation rules", async () => {
    const write: Call = { name: "write_file", result: ok };
    expect((await scenario([[write], [check()]])).requests).toBe(3);
    expect((await scenario([[check(), write]])).prompts).toEqual([NEEDS_VERIFY_PROMPT, NEEDS_VERIFY_PROMPT]);
  });
  it("keeps test-repair attempts capped at three", async () => {
    const result = await scenario([[edit()], ...Array.from({ length: 4 }, () => [check(failing)])]);
    expect(result.prompts.filter((p) => p.startsWith(TESTS_FAILED_PREFIX))).toHaveLength(3);
    expect(result.prompts.filter((p) => p === VERIFY_FAILED_PROMPT)).toHaveLength(2);
  });
  it("integrates real built-in metadata into loop", async () => {
    childOutput(" Tests  2 passed (2)\n");
    const result = await scenario([[edit()], [{ name: "run_tests", builtin: true, input: { framework: "vitest" } }]]);
    expect(result.requests).toBe(3);
    expect(result.prompts).toEqual([]);
  });
});

describe("built-in test runner", () => {
  it("does not credit pytest warning text when the actual summary is skipped-only", async () => {
    childOutput("s [100%]\n================ warnings summary ================\ntest_value.py:3: UserWarning: previously 2 passed\n  warnings.warn('previously 2 passed')\n1 skipped, 1 warning in 0.01s\n");
    const result = await testRunnerTool.execute({ framework: "pytest" });
    expect(result.isError).toBe(false);
    expect(result.verification).toMatchObject({ status: "inconclusive", passed: 0, exitCode: 0 });
  });
  it.each([
    "2 passed, 1 warning in 0.03s",
    "================ 2 passed in 0.03s ================",
    "2 passed in 61.23s (0:01:01)",
  ])("recognizes pytest summary %s", async (summary) => {
    childOutput(summary);
    const result = await testRunnerTool.execute({ framework: "pytest" });
    expect(result.verification).toMatchObject({ status: "passed", passed: 2 });
  });
  it("does not interpret FAIL inside a passing test title as a failure", async () => {
    childOutput(" ✓ example.test.ts > returns FAIL for invalid input\n Tests  1 passed (1)\n");
    const result = await testRunnerTool.execute({ framework: "vitest" });
    expect(result.isError).toBe(false);
    expect(result.verification?.status).toBe("passed");
    expect(result.output).not.toContain("Failures:");
  });
  it.each([
    ["vitest", " Test Files  9 passed (9)\n Tests  2 passed (2)", 2],
    ["jest", "Test Suites: 9 passed, 9 total\nTests: 2 passed, 2 total", 2],
    ["pytest", "2 passed in 0.1s", 2],
    ["go", "--- PASS: TestThing (0.00s)\nPASS\nok pkg", 1],
    ["cargo", "test result: ok. 2 passed; 0 failed\ntest result: ok. 3 passed; 0 failed", 5],
  ])("credits actual positive passing tests for %s", async (framework, output, passed) => {
    childOutput(String(output));
    const result = await testRunnerTool.execute({ framework });
    expect(result.isError).toBe(false);
    expect(result.verification).toMatchObject({ status: "passed", passed, exitCode: 0 });
    expect(result.output).toContain(`Passed: ${passed}`);
  });
  it.each(["", "No tests found", " Test Files  1 passed (1)", "Tests: 0 passed, 0 total", "unrecognized output"])("does not verify zero/unparsed output: %s", async (output) => {
    childOutput(output);
    const result = await testRunnerTool.execute({ framework: "vitest" });
    expect(result.isError).toBe(false);
    expect(result.verification).toMatchObject({ status: "inconclusive", passed: 0 });
    if (output) expect(result.output).toContain(output);
  });
  it.each([
    Object.assign(new Error("command failed"), { code: 2 }),
    Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }),
    Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }),
    Object.assign(new Error("signal terminated"), { signal: "SIGINT" }),
  ])("reports process failures despite passing stdout: %s", async (err) => {
    childOutput(" Tests  2 passed (2)", err, "raw diagnostic");
    const result = await testRunnerTool.execute({ framework: "vitest" });
    expect(result.isError).toBe(true);
    expect(result.verification?.status).toBe("failed");
    expect(result.output).toContain(err.message);
    expect(result.output).toContain("raw diagnostic");
  });
  it("handles synchronous startup exceptions", async () => {
    vi.mocked(execFile).mockImplementation(() => { throw new Error("startup exception"); });
    const result = await testRunnerTool.execute({ framework: "vitest" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("startup exception");
    expect(result.verification?.status).toBe("failed");
  });
  it("keeps recognized failures and counts", async () => {
    childOutput(" Tests  1 failed | 2 passed (3)\n × example\n AssertionError: expected true");
    const result = await testRunnerTool.execute({ framework: "vitest" });
    expect(result.isError).toBe(true);
    expect(result.verification).toMatchObject({ status: "failed", passed: 2, failed: 1 });
    expect(result.output).toContain("example");
    expect(result.output).toContain("AssertionError");
  });
  it("does not drop failures in later cargo suites", async () => {
    childOutput("test result: ok. 2 passed; 0 failed\ntest result: FAILED. 0 passed; 1 failed");
    const result = await testRunnerTool.execute({ framework: "cargo" });
    expect(result.isError).toBe(true);
    expect(result.verification).toMatchObject({ status: "failed", passed: 2, failed: 1 });
  });
});
