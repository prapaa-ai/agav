import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";

describe("iterations budget behavior", () => {
  it("shares budget with sub-agents and does not reset on auto-continue", async () => {
    const budget = { remaining: 5, total: 5 };
    // Minimal mock provider
    const provider = {
      stream: async function* () {
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_complete" };
      },
    } as any;

    const conversation = { 
      getMessages: () => [], 
      setContextWindow: () => {},
      compactIfNeeded: async () => ({ compacted: false, droppedCount: 0 }),
      addInternalUserMessage: () => {},
      addUserMessage: () => {},
    } as any;

    const toolRegistry = { getSchemas: () => [] } as any;

    // First loop consumes 1 iteration
    const loop1 = runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "m",
      systemPrompt: "",
      effort: "medium",
      maxTokens: 100,
      iterationsBudget: budget,
      signal: new AbortController().signal,
      confirmTool: async () => "yes",
      permissionMode: "ask",
    });

    // Consume one iteration
    for await (const _ of loop1) break;

    expect(budget.remaining).toBeLessThan(5);

    // Simulate auto-continue: same budget object passed again
    const loop2 = runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "m",
      systemPrompt: "",
      effort: "medium",
      maxTokens: 100,
      iterationsBudget: budget,
      signal: new AbortController().signal,
      confirmTool: async () => "yes",
      permissionMode: "ask",
    });

    for await (const _ of loop2) break;

    // Budget should continue decreasing, not reset
    expect(budget.remaining).toBeLessThan(5);
  });

  it("throws when iterationsBudget is missing", async () => {
    const provider = { stream: async function* () {} } as any;
    const conversation = { getMessages: () => [], setContextWindow: () => {}, compactIfNeeded: async () => ({ compacted: false }), addInternalUserMessage: () => {} } as any;
    const toolRegistry = { getSchemas: () => [] } as any;

    await expect(async () => {
      const loop = runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: "m",
        systemPrompt: "",
        effort: "medium",
        maxTokens: 100,
        signal: new AbortController().signal,
        confirmTool: async () => ({ action: "allow" }),
        permissionMode: "ask",
      } as any);
      for await (const _ of loop) break;
    }).rejects.toThrow("iterationsBudget is required");
  });

  it("pre-reserves budget before async work", async () => {
    const budget = { remaining: 1, total: 1 };
    const provider = {
      stream: async function* () {
        // Simulate async work
        await new Promise(r => setTimeout(r, 1));
        yield { type: "text_delta", text: "x" };
        yield { type: "message_complete" };
      },
    } as any;

    const conversation = { 
      getMessages: () => [], 
      setContextWindow: () => {},
      compactIfNeeded: async () => ({ compacted: false, droppedCount: 0 }),
      addInternalUserMessage: () => {},
    } as any;
    const toolRegistry = { getSchemas: () => [] } as any;

    const loop = runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "m",
      systemPrompt: "",
      effort: "medium",
      maxTokens: 100,
      iterationsBudget: budget,
      signal: new AbortController().signal,
      confirmTool: async () => "yes",
      permissionMode: "ask",
    });

    // Budget should be decremented immediately on loop start, not after work
    // The first iteration decrements synchronously before the first await inside the loop body
    // Consume first yielded value to ensure loop has started
    const iterator = loop[Symbol.asyncIterator]();
    // Trigger start
    const first = await iterator.next();
    // Budget already decremented
    expect(budget.remaining).toBe(0);
  });
});
