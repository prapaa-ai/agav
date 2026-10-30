import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../config/config.js";
import type { AgavConfig } from "../config/config.js";
import { listSessions, loadSession } from "../config/history.js";
import { ConversationState } from "../agent/conversation.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { decideSessionApproval, listPendingApprovals } from "../sessions/approvals.js";
import { requestSessionCancellation } from "../sessions/client.js";
import { createSessionExecution, startSessionExecution, type SessionExecutionHandle } from "../sessions/runner.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { ToolRegistry } from "../tools/registry.js";

let root: string;
let store: SessionRuntimeStore;
const handles: SessionExecutionHandle[] = [];
const releases: Array<() => void> = [];
const config: AgavConfig = { provider: "anthropic", model: "claude-sonnet-4-6", effort: "low", maxTokens: 128,
  maxIterations: 3, errorRetries: 0, permissionMode: "ask", systemPrompt: "Checkpoint fixture" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-session-checkpoints-"));
  // Both legacy history and the default runtime store must stay out of the real profile.
  vi.spyOn(configModule, "getAgavDir").mockReturnValue(root);
  store = new SessionRuntimeStore();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(handles.splice(0).map(handle => handle.shutdown()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
async function runtime() {
  const conversation = new ConversationState();
  conversation.addUserMessage("Make a checkpointed change");
  return createSessionExecution(store, config, { conversation });
}
function start(id: string, provider: LLMProvider, registry = new ToolRegistry()) {
  const handle = startSessionExecution(id, { store, config, provider, registry });
  handles.push(handle);
  return handle;
}
function writeRegistry() {
  const execute = vi.fn(async () => ({ output: "fixture written", isError: false }));
  const registry = new ToolRegistry();
  registry.register({ schema: { name: "checkpoint_write", description: "Write a fixture",
    inputSchema: { type: "object", properties: { path: { type: "string" } } } }, execute });
  return { registry, execute };
}
async function pending(id: string) {
  await vi.waitFor(async () => {
    await store.lock(id, async () => {
      expect(await listPendingApprovals(store, id)).toHaveLength(1);
      expect((await store.read(id))!.status).toBe("needs-approval");
    });
  }, { timeout: 3000, interval: 20 });
  return (await listPendingApprovals(store, id))[0]!;
}

function toolTurn(): StreamEvent[] {
  return [
    { type: "tool_call_start", toolCallId: "fixture-call", toolName: "checkpoint_write" },
    { type: "tool_call_delta", toolCallId: "fixture-call", argsJson: '{"path":"fixture.txt"}' },
    { type: "tool_call_end", toolCallId: "fixture-call" },
    { type: "message_end", stopReason: "tool_calls" },
  ];
}

describe("worker checkpoints", () => {
  it("coalesces hundreds of deltas and publishes streaming text even while the provider is idle", async () => {
    const record = await runtime();
    const finish = gate();
    let idle = false;
    const count = 300;
    const update = vi.spyOn(store, "update");
    const usage = { inputTokens: 19, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 };
    const provider: LLMProvider = { name: "fixture", async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "usage", ...usage };
      for (let i = 0; i < count; i++) {
        yield { type: "text_delta", text: "x" };
        yield { type: "thinking_delta", text: "y" };
      }
      idle = true;
      await finish.promise;
      yield { type: "message_end", stopReason: "end_turn" };
    } };
    const handle = start(record.id, provider);
    try {
      await vi.waitFor(() => { expect(idle).toBe(true); }, { timeout: 3000, interval: 20 });
      await vi.waitFor(async () => {
        expect(await new SessionRuntimeStore().read(record.id)).toMatchObject({ status: "running",
          streamingText: "x".repeat(count), thinkingText: "y".repeat(count), tokenUsage: usage });
      }, { timeout: 3000, interval: 20 });
      // The provider is still blocked before message_end: this must be a timed checkpoint,
      // not a snapshot saved only when another provider event arrives.
      expect(update.mock.calls.length).toBeLessThanOrEqual(6);
      expect((await store.read(record.id))!.messages).toEqual(record.messages);
    } finally { finish.release(); }
    const result = await handle.done;
    expect(result.status, result.error).toBe("completed");
    expect(update.mock.calls.length).toBeLessThan(15);
    expect(result).toMatchObject({ streamingText: "", thinkingText: "", tokenUsage: usage });
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "x".repeat(count) }] });
    expect(await loadSession(record.id)).toMatchObject({ messages: JSON.parse(JSON.stringify(result.messages)), tokenUsage: usage });
    expect(await listSessions()).toEqual([expect.objectContaining({ id: record.id, messages: JSON.parse(JSON.stringify(result.messages)), tokenUsage: usage })]);
    const events = (await readFile(join(store.directory(record.id), "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.type === "streaming_text")).toHaveLength(count);
    expect(events.filter(event => event.type === "thinking")).toHaveLength(count);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", generation: record.generation });
  });

  it("durably cancels an approval-blocked worker without executing the tool or leaving pending consent", async () => {
    const record = await runtime();
    const { registry, execute } = writeRegistry();
    const stream = vi.fn(async function* (): AsyncGenerator<StreamEvent> { yield* toolTurn(); });
    const handle = start(record.id, { name: "fixture", stream }, registry);
    await pending(record.id);
    expect((await store.read(record.id))!.status).toBe("needs-approval");
    expect(execute).not.toHaveBeenCalled();
    await requestSessionCancellation(record.id, record.generation, new SessionRuntimeStore());
    await vi.waitFor(async () => {
      expect((await store.read(record.id))!.status).toBe("interrupted");
    }, { timeout: 3000, interval: 20 });
    const result = await handle.done;
    expect(result).toMatchObject({ status: "interrupted", cancelRequested: true, streamingText: "", thinkingText: "" });
    expect(execute).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(await listPendingApprovals(new SessionRuntimeStore(), record.id)).toEqual([]);
    expect(await loadSession(record.id)).toMatchObject({ messages: JSON.parse(JSON.stringify(result.messages)), tokenUsage: result.tokenUsage });
  });

  it("rejects cancellation from a previous generation without mutating the new execution", async () => {
    const previous = await runtime();
    await store.update(previous.id, previous.generation, current => { current.status = "completed"; });
    const conversation = new ConversationState();
    conversation.addUserMessage("A fresh execution");
    const current = await createSessionExecution(store, config, { id: previous.id,
      previousGeneration: previous.generation, conversation });
    await expect(requestSessionCancellation(current.id, previous.generation, new SessionRuntimeStore())).rejects.toThrow(/stale/i);
    expect(await store.read(current.id)).toEqual(current);
  });
});

/** Full SDK SSE frames, rather than mocking AnthropicProvider.stream or the agent loop. */
function anthropicResponse(tool: boolean) {
  const frames = [
    { type: "message_start", message: { id: tool ? "msg-tool" : "msg-final", type: "message", role: "assistant",
      model: config.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: tool ? 11 : 17, output_tokens: 0,
        cache_read_input_tokens: tool ? 2 : 3, cache_creation_input_tokens: tool ? 4 : 6 } } },
    { type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: "sdk-call", name: "checkpoint_write", input: {} }
      : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: '{"path":"fixture.txt"}' }
      : { type: "text_delta", text: "SDK fixture finished" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: tool ? 5 : 7 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", "request-id": "fixture-request" } });
}

describe("Anthropic SDK worker checkpoints", () => {
  it("uses mocked HTTP transport for tool approval and final text, preserving cumulative usage in real history", async () => {
    const requests: Array<Record<string, any>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/models/")) return Response.json({ id: config.model, type: "model", display_name: "Fixture",
        created_at: "2025-01-01T00:00:00Z", max_input_tokens: 200000 });
      expect(url).toContain("/messages");
      requests.push(JSON.parse(String(init?.body)));
      expect(requests.length).toBeLessThanOrEqual(2);
      return anthropicResponse(requests.length === 1);
    });
    vi.stubGlobal("fetch", fetch);
    const record = await runtime();
    const { registry, execute } = writeRegistry();
    const handle = start(record.id, new AnthropicProvider("fixture-key-not-a-live-credential"), registry);
    const approval = await pending(record.id);
    expect(approval).toMatchObject({ toolName: "checkpoint_write", input: { path: "fixture.txt" }, generation: record.generation });
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(await loadSession(record.id)).toMatchObject({ tokenUsage: {
      inputTokens: 11, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 4 } });
    await decideSessionApproval(new SessionRuntimeStore(), record.id, approval.approvalId, "yes",
      { generation: record.generation, inputHash: approval.inputHash });
    const result = await handle.done;
    expect(result.status, result.error).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.flatMap((message: any) => message.content)).toContainEqual(
      expect.objectContaining({ type: "tool_result", tool_use_id: "sdk-call", content: "fixture written", is_error: false }));
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "SDK fixture finished" }] });
    const usage = { inputTokens: 28, outputTokens: 12, cacheReadTokens: 5, cacheWriteTokens: 10 };
    expect(result.tokenUsage).toEqual(usage);
    expect(await loadSession(record.id)).toMatchObject({ messages: JSON.parse(JSON.stringify(result.messages)), tokenUsage: usage });
    expect(await listSessions()).toEqual([expect.objectContaining({ id: record.id, messages: JSON.parse(JSON.stringify(result.messages)), tokenUsage: usage })]);
    expect(await listPendingApprovals(store, record.id)).toEqual([]);
  });
});
