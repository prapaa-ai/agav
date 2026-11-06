import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../config/config.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, Message, StreamEvent } from "../providers/types.js";
import { ConversationState } from "../agent/conversation.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "../sessions/store.js";
import { drainSessionSteers, requestSessionSteer } from "../sessions/client.js";
import { createSessionExecution, prepareSessionTools, startSessionExecution, type SessionExecutionHandle } from "../sessions/runner.js";
import { ToolRegistry } from "../tools/registry.js";

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 128,
  maxIterations: 6, errorRetries: 0, permissionMode: "auto-accept", systemPrompt: "fixture" };
let root: string;
let store: SessionRuntimeStore;
let record: SessionRuntimeRecord;
const handles: SessionExecutionHandle[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-session-steer-"));
  vi.spyOn(configModule, "getAgavDir").mockReturnValue(root);
  store = new SessionRuntimeStore(root);
  const conversation = new ConversationState();
  conversation.addUserMessage("Do the task");
  record = await createSessionExecution(store, config, { conversation });
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.shutdown()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function observer() { return new SessionRuntimeStore(root); }
function child(id = "child-1") {
  return { id, title: "Child", task: "Do the task", status: "running" as const, toolCalls: [], thinkingText: "",
    streamingText: "", startedAt: Date.now(), totalToolCalls: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
}
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function texts(messages: Message[]) {
  return messages.filter(message => message.role === "user").flatMap(message => message.content)
    .filter(block => block.type === "text").map(block => block.text).join("\n");
}
function toolTurn(name: string, input: Record<string, unknown> = {}): StreamEvent[] {
  return [{ type: "tool_call_start", toolCallId: "call", toolName: name },
    { type: "tool_call_delta", toolCallId: "call", argsJson: JSON.stringify(input) },
    { type: "tool_call_end", toolCallId: "call" }, { type: "message_end", stopReason: "tool_calls" }];
}

describe("durable steering admission and consumption", () => {
  it("accepts main steering while starting and isolates recipient inboxes across store instances", async () => {
    await requestSessionSteer(record.id, record.generation, "main only", undefined, observer());
    await store.update(record.id, record.generation, current => { current.subagentStates = [child(), child("child-2")]; });
    await requestSessionSteer(record.id, record.generation, "child only", "child-1", observer());
    expect(await drainSessionSteers(record.id, record.generation, "child-2", false, observer())).toEqual([]);
    expect(await drainSessionSteers(record.id, record.generation, undefined, false, observer())).toEqual(["main only"]);
    expect(await drainSessionSteers(record.id, record.generation, undefined, false, observer())).toEqual([]);
    expect(await drainSessionSteers(record.id, record.generation, "child-1", false, observer())).toEqual(["child only"]);
  });

  it("atomically closes only the final-drained recipient, rejecting completion-racing requests", async () => {
    await store.update(record.id, record.generation, current => { current.subagentStates = [child()]; });
    await requestSessionSteer(record.id, record.generation, "last", undefined, observer());
    expect(await drainSessionSteers(record.id, record.generation, undefined, true, observer())).toEqual(["last"]);
    await expect(requestSessionSteer(record.id, record.generation, "too late", undefined, observer())).rejects.toThrow(/closed|completed/);
    await requestSessionSteer(record.id, record.generation, "child last", "child-1", observer());
    expect(await drainSessionSteers(record.id, record.generation, "child-1", true, observer())).toEqual(["child last"]);
    await expect(requestSessionSteer(record.id, record.generation, "too late", "child-1", observer())).rejects.toThrow(/closed|completed/);
    expect((await store.read(record.id))?.closedSteerTargets).toEqual(["main", "child-1"]);
  });

  it("serializes concurrent admission with final drain without stranding an accepted request", async () => {
    const [admission, drained] = await Promise.allSettled([
      requestSessionSteer(record.id, record.generation, "racing", undefined, observer()),
      drainSessionSteers(record.id, record.generation, undefined, true, observer()),
    ]);
    expect(drained.status).toBe("fulfilled");
    if (admission.status === "fulfilled") expect(drained).toEqual({ status: "fulfilled", value: ["racing"] });
    else expect(String(admission.reason)).toMatch(/closed|completed/);
    expect((await store.read(record.id))?.steers?.some(item => item.status === "pending") ?? false).toBe(false);
  });

  it("rejects missing, stale, cancelled and completed recipients without enqueueing", async () => {
    await expect(requestSessionSteer("missing", record.generation, "bad", undefined, store)).rejects.toThrow(/missing|stale/i);
    await expect(requestSessionSteer(record.id, "stale", "bad", undefined, store)).rejects.toThrow(/stale/i);
    await expect(requestSessionSteer(record.id, record.generation, "bad", "missing", store)).rejects.toThrow(/missing/i);
    await store.update(record.id, record.generation, current => { current.subagentStates = [child("skill-running")]; });
    await expect(requestSessionSteer(record.id, record.generation, "bad", "skill-running", store)).rejects.toThrow(/not supported/i);
    await store.update(record.id, record.generation, current => {
      current.subagentStates = [child()]; current.cancelledSubagents = ["child-1"];
    });
    await expect(requestSessionSteer(record.id, record.generation, "bad", "child-1", store)).rejects.toThrow(/cancelled/i);
    await store.update(record.id, record.generation, current => { current.cancelRequested = true; });
    await expect(requestSessionSteer(record.id, record.generation, "bad", undefined, store)).rejects.toThrow(/inactive/i);
    for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
      await store.update(record.id, record.generation, current => { current.cancelRequested = false; current.status = status; });
      await expect(requestSessionSteer(record.id, record.generation, "bad", undefined, store)).rejects.toThrow(/inactive/i);
    }
    expect((await store.read(record.id))?.steers).toBeUndefined();
  });

  it("marks accepted but unconsumed requests rejected when the child or session settles", async () => {
    await store.update(record.id, record.generation, current => { current.subagentStates = [child()]; });
    await requestSessionSteer(record.id, record.generation, "child", "child-1", store);
    await requestSessionSteer(record.id, record.generation, "main", undefined, store);
    await store.update(record.id, record.generation, current => { current.subagentStates![0]!.status = "error"; });
    expect((await store.read(record.id))?.steers?.map(item => item.status)).toEqual(["rejected", "pending"]);
    await store.update(record.id, record.generation, current => { current.status = "failed"; });
    expect((await store.read(record.id))?.steers?.map(item => item.status)).toEqual(["rejected", "rejected"]);
  });
});

describe("gated worker steering", () => {
  it("delivers durable main-only steering at the next worker safe point", async () => {
    const blocked = gate();
    const entered = gate();
    const registry = new ToolRegistry();
    registry.register({ schema: { name: "gate", description: "Gate", inputSchema: { type: "object", properties: {} } },
      execute: async () => { entered.release(); await blocked.promise; return { output: "released", isError: false }; } });
    const seen: string[] = [];
    const provider: LLMProvider = { name: "fixture", async *stream(params) {
      seen.push(texts(structuredClone(params.messages)));
      if (seen.length === 1) yield* toolTurn("gate");
      else { yield { type: "text_delta", text: "done" }; yield { type: "message_end", stopReason: "end_turn" }; }
    } };
    const handle = startSessionExecution(record.id, { store, config, provider, registry });
    handles.push(handle);
    try {
      await entered.promise;
      await requestSessionSteer(record.id, record.generation, "MAIN_DIRECTIVE", undefined, observer());
    } finally { blocked.release(); }
    const result = await handle.done;
    expect(result.status, result.error).toBe("completed");
    expect(seen[0]).not.toContain("MAIN_DIRECTIVE");
    expect(seen.slice(1).some(text => text.includes("MAIN_DIRECTIVE"))).toBe(true);
    await expect(requestSessionSteer(record.id, record.generation, "late", undefined, observer())).rejects.toThrow(/inactive|closed/);
  });

  it("delivers child-only steering without leaking it to the parent provider", async () => {
    const blocked = gate();
    const entered = gate();
    const parentTexts: string[] = [];
    const childTexts: string[] = [];
    let calls = 0;
    const provider: LLMProvider = { name: "fixture", async *stream(params) {
      const call = calls++;
      if (call === 0) {
        parentTexts.push(texts(structuredClone(params.messages)));
        yield* toolTurn("subagent", { title: "Child", task: "Inspect the task" });
      } else if (call === 1) {
        childTexts.push(texts(structuredClone(params.messages)));
        yield* toolTurn("child_gate");
      } else {
        (call === 2 ? childTexts : parentTexts).push(texts(structuredClone(params.messages)));
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", stopReason: "end_turn" };
      }
    } };
    const handle = startSessionExecution(record.id, { store, config, provider, prepareTools: async ctx => {
      ctx.registry.register({ schema: { name: "child_gate", description: "Gate", inputSchema: { type: "object", properties: {} } },
        execute: async () => { entered.release(); await blocked.promise; return { output: "released", isError: false }; } });
      return prepareSessionTools(ctx);
    } });
    handles.push(handle);
    try {
      await entered.promise;
      let childId!: string;
      await vi.waitFor(async () => {
        childId = (await store.read(record.id))?.subagentStates?.find(item => item.status === "running")?.id ?? "";
        expect(childId).not.toBe("");
      });
      await requestSessionSteer(record.id, record.generation, "CHILD_DIRECTIVE", childId, observer());
    } finally { blocked.release(); }
    const result = await handle.done;
    expect(result.status, result.error).toBe("completed");
    expect(childTexts.slice(1).some(text => text.includes("CHILD_DIRECTIVE"))).toBe(true);
    expect(parentTexts.every(text => !text.includes("CHILD_DIRECTIVE"))).toBe(true);
    expect(result.steers).toEqual([expect.objectContaining({ status: "consumed", directive: "CHILD_DIRECTIVE" })]);
  });
});
