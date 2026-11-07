import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, type AgentEvent, type SteerDrainOptions } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { STEER_DIRECTIVE_PREFIX } from "../agent/internal-prompts.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "../sessions/store.js";
import { drainSessionSteers, requestSessionSteer } from "../sessions/client.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, Message, StreamEvent } from "../providers/types.js";

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function texts(messages: Message[]) {
  return messages.filter(message => message.role === "user").flatMap(message => message.content)
    .filter(block => block.type === "text").map(block => block.text).join("\n");
}
async function collect(loop: AsyncIterable<AgentEvent>, events: AgentEvent[]) {
  for await (const event of loop) events.push(event);
}

let root: string;
let store: SessionRuntimeStore;
let record: SessionRuntimeRecord;
const childIds = ["child-1", "child-2"];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-steer-budget-race-"));
  store = new SessionRuntimeStore(root);
  record = await store.create({ cwd: root, model: "mock", provider: "anthropic", permissionMode: "auto-accept",
    sandboxRequired: false, subagentStates: childIds.map(id => ({
      id, title: id, task: "Inspect", status: "running", toolCalls: [], thinkingText: "", streamingText: "",
      startedAt: Date.now(), totalToolCalls: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    })) });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function durableDrain(childId: string, options?: SteerDrainOptions) {
  return drainSessionSteers(record.id, record.generation, childId, options, new SessionRuntimeStore(root));
}

describe("shared continuation reservations for durable child steering", () => {
  it.each(["text-only final", "post-tool boundary"] as const)(
    "only acknowledges the reservation winner at the %s", async boundary => {
      const responseGate = gate();
      const drainGate = gate();
      const budget = { remaining: 3, total: 3 };
      const snapshots = new Map<string, Message[][]>(childIds.map(id => [id, []]));
      const events = new Map<string, AgentEvent[]>(childIds.map(id => [id, []]));
      const boundaryDrains: { childId: string; options: SteerDrainOptions }[] = [];
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => ({ output: "inspected", isError: false }));
      registry.register({ schema: { name: "inspect", description: "Inspect", inputSchema: { type: "object", properties: {} } }, execute });
      const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
        const calls = snapshots.get(params.systemPrompt!)!;
        calls.push(structuredClone(params.messages));
        if (calls.length === 1) {
          await responseGate.promise;
          if (boundary === "post-tool boundary") {
            yield { type: "tool_call_start", toolCallId: "inspect-call", toolName: "inspect" };
            yield { type: "tool_call_delta", toolCallId: "inspect-call", argsJson: "{}" };
            yield { type: "message_end", stopReason: "tool_calls" };
            return;
          }
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", stopReason: "end_turn" };
      } };
      const running = childIds.map(childId => {
        const conversation = new ConversationState();
        conversation.addUserMessage("Inspect");
        return collect(runAgentLoop({ provider, conversation, toolRegistry: registry, model: "mock", systemPrompt: childId,
          permissionMode: "auto-accept", iterationsBudget: budget,
          drainSteers: async options => {
            // Startup drains are real but have no directives yet. Hold the
            // reservation winner before durable consumption; a waiter may
            // only reach its drain once the winner spends the last slot.
            if (snapshots.get(childId)!.length === 1) {
              boundaryDrains.push({ childId, options: { ...options } });
              await drainGate.promise;
            }
            return durableDrain(childId, options);
          },
        }), events.get(childId)!);
      });
      try {
        await vi.waitFor(() => expect([...snapshots.values()].map(calls => calls.length)).toEqual([1, 1]));
        expect(budget.remaining).toBe(1);
        for (const childId of childIds) {
          await requestSessionSteer(record.id, record.generation, `DIRECTIVE_${childId}`, childId, new SessionRuntimeStore(root));
        }
        expect((await store.read(record.id))!.steers!.map(steer => steer.status)).toEqual(["pending", "pending"]);
        responseGate.release();
        await vi.waitFor(() => expect(boundaryDrains.some(drain => drain.options.canContinue)).toBe(true));
        expect(budget.remaining).toBe(0);
        expect((await store.read(record.id))!.steers!.map(steer => steer.status)).toEqual(["pending", "pending"]);
        // Do not await both drains while holding the winner: the loser waits
        // for that reservation to be spent before reporting exhaustion.
        drainGate.release();
        await vi.waitFor(() => expect(new Set(boundaryDrains.map(drain => drain.childId)).size).toBe(2));
      } finally {
        responseGate.release();
        drainGate.release();
        await Promise.all(running);
      }

      const consumed = (await store.read(record.id))!.steers!.filter(steer => steer.status === "consumed");
      const rejected = (await store.read(record.id))!.steers!.filter(steer => steer.status === "rejected");
      expect(consumed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const winner = consumed[0]!.target;
      const loser = rejected[0]!.target;
      expect(boundaryDrains.find(drain => drain.childId === winner)!.options.canContinue).toBe(true);
      expect(boundaryDrains.find(drain => drain.childId === loser)!.options.canContinue).toBe(false);
      expect(rejected[0]!.error).toMatch(/budget.*exhausted/i);
      expect(events.get(winner)!.filter(event => event.type === "steer_applied")).toEqual([
        { type: "steer_applied", directives: [`DIRECTIVE_${winner}`] },
      ]);
      expect(events.get(loser)!.some(event => event.type === "steer_applied")).toBe(false);
      expect(snapshots.get(winner)).toHaveLength(2);
      expect(texts(snapshots.get(winner)![1]!)).toContain(STEER_DIRECTIVE_PREFIX + `DIRECTIVE_${winner}`);
      expect(snapshots.get(loser)).toHaveLength(1);
      expect(texts(snapshots.get(loser)![0]!)).not.toContain("DIRECTIVE_");
      expect([...snapshots.values()].reduce((total, calls) => total + calls.length, 0)).toBe(3);
      expect(budget.remaining).toBe(0);
      if (boundary === "post-tool boundary") {
        expect(execute).toHaveBeenCalledTimes(2);
        const messages = snapshots.get(winner)![1]!;
        const toolIndex = messages.findIndex(message => message.content.some(block => block.type === "tool_use"));
        expect(messages[toolIndex + 1]!.content.some(block => block.type === "tool_result")).toBe(true);
        expect(texts(messages.slice(toolIndex + 2))).toContain(`DIRECTIVE_${winner}`);
      }
    },
  );

  describe.each(["text-only final", "post-tool boundary"] as const)("waiting at the %s", boundary => {
    it.each([false, true])("waits for an empty final drain to release its slot (cancelled: %s)", async cancelled => {
      const responseGates = childIds.map(() => gate());
      const emptyDrainEntered = gate();
      const emptyDrainGate = gate();
      const waiterAtBoundary = gate();
      const waiterSettled = gate();
      const controller = new AbortController();
      const budget = { remaining: 3, total: 3 };
      const snapshots = childIds.map(() => [] as Message[][]);
      const events = childIds.map(() => [] as AgentEvent[]);
      const boundaryDrains: SteerDrainOptions[] = [];
      let settled = false;
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => ({ output: "inspected", isError: false }));
      registry.register({ schema: { name: "inspect", description: "Inspect", inputSchema: { type: "object", properties: {} } }, execute });
      const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
        const index = childIds.indexOf(params.systemPrompt!);
        const calls = snapshots[index]!;
        calls.push(structuredClone(params.messages));
        if (calls.length === 1) {
          await responseGates[index]!.promise;
          if (index === 1 && boundary === "post-tool boundary") {
            yield { type: "tool_call_start", toolCallId: "inspect-call", toolName: "inspect" };
            yield { type: "tool_call_delta", toolCallId: "inspect-call", argsJson: "{}" };
            yield { type: "message_end", stopReason: "tool_calls" };
            return;
          }
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", stopReason: "end_turn" };
      } };
      const running = childIds.map((childId, index) => {
        const conversation = new ConversationState();
        conversation.addUserMessage("Inspect");
        const loop = runAgentLoop({ provider, conversation, toolRegistry: registry, model: "mock", systemPrompt: childId,
          permissionMode: "auto-accept", iterationsBudget: budget, signal: index === 1 ? controller.signal : undefined,
          drainSteers: async options => {
            if (snapshots[index]!.length === 1) {
              if (index === 0) {
                expect(options).toMatchObject({ final: true, canContinue: true });
                emptyDrainEntered.release();
                await emptyDrainGate.promise;
              } else boundaryDrains.push({ ...options });
            }
            return durableDrain(childId, options);
          },
        });
        return (async () => {
          for await (const event of loop) {
            events[index]!.push(event);
            if (index === 1 && (boundary === "post-tool boundary"
              ? event.type === "tool_result" : event.type === "assistant_message_complete")) waiterAtBoundary.release();
          }
        })().finally(() => {
          if (index === 1) {
            settled = true;
            waiterSettled.release();
          }
        });
      });
      try {
        await vi.waitFor(() => expect(snapshots.map(calls => calls.length)).toEqual([1, 1]));
        expect(budget.remaining).toBe(1);
        await requestSessionSteer(record.id, record.generation, "DIRECTIVE_WAITER", "child-2", new SessionRuntimeStore(root));
        responseGates[0]!.release();
        await emptyDrainEntered.promise;
        expect(budget.remaining).toBe(0);
        responseGates[1]!.release();
        await waiterAtBoundary.promise;
        // Let the waiter advance past the yielded boundary. An eager exhausted
        // drain would settle here, while a reservation wait remains suspended.
        await Promise.race([waiterSettled.promise, new Promise(resolve => setTimeout(resolve, 100))]);
        expect(settled).toBe(false);
        expect(boundaryDrains).toEqual([]);
        expect(events[1]!.some(event => event.type === "error" || event.type === "turn_complete")).toBe(false);
        expect((await store.read(record.id))!.steers!.map(steer => steer.status)).toEqual(["pending"]);
        if (cancelled) {
          controller.abort();
          await vi.waitFor(() => expect(settled).toBe(true));
          // Cancellation must not need the reservation owner to unblock first.
          expect(events[1]!.at(-1)).toEqual({ type: "error", error: new Error("Aborted") });
          expect(boundaryDrains).toEqual([]);
          expect(budget.remaining).toBe(0);
          expect((await store.read(record.id))!.steers!.map(steer => steer.status)).toEqual(["pending"]);
        }
      } finally {
        for (const responseGate of responseGates) responseGate.release();
        emptyDrainGate.release();
        await Promise.all(running);
      }
      expect(events[0]!.at(-1)).toEqual({ type: "turn_complete" });
      expect(events[0]!.some(event => event.type === "steer_applied")).toBe(false);
      if (cancelled) {
        expect(snapshots.map(calls => calls.length)).toEqual([1, 1]);
        expect(budget.remaining).toBe(1);
        expect(events[1]!.some(event => event.type === "steer_applied")).toBe(false);
      } else {
        expect(boundaryDrains).toEqual([expect.objectContaining({ canContinue: true })]);
        expect(snapshots.map(calls => calls.length)).toEqual([1, 2]);
        expect(texts(snapshots[1]![1]!)).toContain(STEER_DIRECTIVE_PREFIX + "DIRECTIVE_WAITER");
        expect(snapshots.reduce((total, calls) => total + calls.length, 0)).toBe(3);
        expect(budget.remaining).toBe(0);
        expect((await store.read(record.id))!.steers!.map(steer => steer.status)).toEqual(["consumed"]);
        expect(events[1]!.filter(event => event.type === "steer_applied")).toEqual([
          { type: "steer_applied", directives: ["DIRECTIVE_WAITER"] },
        ]);
        expect(events[1]!.at(-1)).toEqual({ type: "turn_complete" });
      }
      if (boundary === "post-tool boundary") expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["empty final drain", "throwing drain", "cancelled drain"] as const)(
    "releases an unused continuation reservation after %s", async outcome => {
      const blocked = gate();
      const entered = gate();
      const budget = { remaining: 2, total: 2 };
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const failure = new Error("drain failed");
      let calls = 0;
      const provider: LLMProvider = { name: "mock", async *stream(): AsyncGenerator<StreamEvent> {
        calls++;
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", stopReason: "end_turn" };
      } };
      const conversation = new ConversationState();
      conversation.addUserMessage("Inspect");
      const running = collect(runAgentLoop({ provider, conversation, toolRegistry: new ToolRegistry(), model: "mock",
        iterationsBudget: budget, signal: controller.signal,
        drainSteers: async options => {
          if (calls === 1) {
            entered.release();
            await blocked.promise;
            if (outcome === "throwing drain") throw failure;
            if (outcome === "cancelled drain") controller.abort();
          }
          return durableDrain("child-1", options);
        },
      }), events).then(() => undefined, error => error as unknown);
      try {
        await entered.promise;
        // One request has run; the other slot is held, not merely checked.
        expect(budget.remaining).toBe(0);
      } finally {
        blocked.release();
        await running;
      }
      if (outcome === "throwing drain") expect(await running).toBe(failure);
      else {
        expect(await running).toBeUndefined();
        expect(events.at(-1)).toEqual(outcome === "cancelled drain"
          ? { type: "error", error: new Error("Aborted") } : { type: "turn_complete" });
      }
      expect(events.some(event => event.type === "steer_applied")).toBe(false);
      expect(calls).toBe(1);
      expect(budget.remaining).toBe(1);
    },
  );
});
