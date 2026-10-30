import * as configModule from "../config/config.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { ConversationState } from "../agent/conversation.js";
import { decideSessionApproval, listPendingApprovals } from "../sessions/approvals.js";
import { createSessionExecution, prepareSessionTools, startSessionExecution } from "../sessions/runner.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { ToolRegistry } from "../tools/registry.js";

// Keep extension discovery out of the test, but use the real worker, loop,
// approval broker, delegated-tool registration, and subagent implementation.
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [] }));

const config: AgavConfig = {
  provider: "anthropic", model: "mock", effort: "low", maxTokens: 128,
  maxIterations: 6, errorRetries: 0, permissionMode: "ask", systemPrompt: "test",
};
const input = { path: "example.txt", content: "hello" };
let root: string;
let store: SessionRuntimeStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-session-progress-"));
  vi.spyOn(configModule, "getAgavDir").mockReturnValue(root);
  store = new SessionRuntimeStore(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function toolEvents(toolName: string, toolCallId: string, args: Record<string, unknown>): StreamEvent[] {
  const json = JSON.stringify(args);
  return [
    { type: "tool_call_start", toolName, toolCallId },
    // Split an incomplete JSON value to exercise argument accumulation.
    { type: "tool_call_delta", toolCallId, argsJson: json.slice(0, 8) },
    { type: "tool_call_delta", toolCallId, argsJson: json.slice(8) },
    { type: "tool_call_end", toolCallId },
    { type: "message_end", stopReason: "tool_calls" },
  ];
}
async function runtime() {
  const conversation = new ConversationState();
  conversation.addUserMessage("inspect the example");
  return createSessionExecution(store, config, { conversation });
}
async function approval(id: string) {
  await vi.waitFor(async () => store.lock(id, async () => {
    expect(await listPendingApprovals(store, id)).toHaveLength(1);
  }));
  return (await listPendingApprovals(store, id))[0]!;
}
function registry(execute: () => Promise<{ output: string; isError: boolean }>) {
  const tools = new ToolRegistry();
  tools.register({
    schema: { name: "test_write", description: "test write", destructive: true,
      inputSchema: { type: "object", properties: {} } },
    execute,
  });
  return tools;
}

describe("durable live session progress", () => {
  it.each([false, true])("persists running input before execution finishes and result before the next model responds (isError=%s)", async isError => {
    const record = await runtime();
    const execution = gate();
    const followup = gate();
    let turn = 0;
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> {
        if (turn++ === 0) {
          yield* toolEvents("test_write", "write-1", input);
        } else {
          await followup.promise;
          yield { type: "text_delta", text: "finished" };
          yield { type: "message_end", stopReason: "end_turn" };
        }
      })()),
    };
    const execute = vi.fn(async () => {
      await execution.promise;
      return { output: isError ? "write failed" : "written", isError };
    });
    const handle = startSessionExecution(record.id, { store, config, provider, registry: registry(execute) });
    const observer = new SessionRuntimeStore(root);
    const runningCall = { toolName: "test_write", toolCallId: "write-1", input, status: "running" };
    try {
      const item = await approval(record.id);
      expect(execute).not.toHaveBeenCalled();
      expect(await observer.read(record.id)).toMatchObject({ status: "needs-approval", toolCalls: [runningCall] });
      await decideSessionApproval(observer, record.id, item.approvalId, "yes", {
        generation: record.generation, inputHash: item.inputHash,
      });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      expect(provider.stream).toHaveBeenCalledTimes(1);
      // This assertion must happen before releasing the tool, not after handle.done.
      expect(await observer.read(record.id)).toMatchObject({ status: "running", toolCalls: [runningCall] });
      execution.release();
      await vi.waitFor(() => expect(provider.stream).toHaveBeenCalledTimes(2));
      expect(await observer.read(record.id)).toMatchObject({
        status: "running",
        toolCalls: [{ ...runningCall, status: isError ? "error" : "done", result: isError ? "write failed" : "written" }],
      });
      followup.release();
      expect(await handle.done).toMatchObject({ status: "completed" });
    } finally {
      execution.release();
      followup.release();
      await handle.shutdown();
    }
  });

  it("persists real delegated progress while the parent loop is waiting for its subagent", async () => {
    const record = await runtime();
    const execution = gate();
    const childFollowup = gate();
    const parentFollowup = gate();
    const delegation = { title: "Inspect example", task: "Inspect the example" };
    let turn = 0;
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> {
        const current = turn++;
        if (current === 0) yield* toolEvents("subagent", "delegate-1", delegation);
        else if (current === 1) yield* toolEvents("test_write", "child-write-1", input);
        else {
          await (current === 2 ? childFollowup.promise : parentFollowup.promise);
          yield { type: "text_delta", text: "inspection complete" };
          yield { type: "message_end", stopReason: "end_turn" };
        }
      })()),
    };
    const execute = vi.fn(async () => {
      await execution.promise;
      return { output: "written", isError: false };
    });
    const handle = startSessionExecution(record.id, {
      store, config, provider, registry: registry(execute), prepareTools: prepareSessionTools,
    });
    const observer = new SessionRuntimeStore(root);
    const childCall = { toolName: "test_write", toolCallId: "child-write-1", input, status: "running" };
    try {
      const delegationApproval = await approval(record.id);
      expect(delegationApproval).toMatchObject({ toolName: "subagent", input: delegation });
      await decideSessionApproval(observer, record.id, delegationApproval.approvalId, "yes");
      const item = await approval(record.id);
      expect(item).toMatchObject({ toolName: "test_write", input, subagentId: "sa-1" });
      expect(execute).not.toHaveBeenCalled();
      await decideSessionApproval(observer, record.id, item.approvalId, "yes");
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => {
        expect(await observer.read(record.id)).toMatchObject({
          status: "running",
          toolCalls: [{ toolName: "subagent", toolCallId: "delegate-1", input: delegation, status: "running" }],
          subagentStates: [{ id: "sa-1", title: delegation.title, status: "running", toolCalls: [childCall] }],
        });
      });
      execution.release();
      await vi.waitFor(() => expect(provider.stream).toHaveBeenCalledTimes(3));
      // The child result must be durable even though neither child nor parent
      // has produced a final response, so no parent-loop event can drive this.
      await vi.waitFor(async () => {
        expect(await observer.read(record.id)).toMatchObject({
          status: "running",
          subagentStates: [{ id: "sa-1", status: "running", toolCalls: [{ ...childCall, status: "done", result: "written" }] }],
        });
      });
      childFollowup.release();
      await vi.waitFor(() => expect(provider.stream).toHaveBeenCalledTimes(4));
      parentFollowup.release();
      expect(await handle.done).toMatchObject({ status: "completed" });
    } finally {
      execution.release();
      childFollowup.release();
      parentFollowup.release();
      await handle.shutdown();
      // The subagent implementation publishes its final removal after 100ms.
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  });
});
