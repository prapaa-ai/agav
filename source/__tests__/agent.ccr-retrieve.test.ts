import { describe, expect, it, beforeEach } from "vitest";

import { ClearedStore, clearedStore } from "../agent/cleared-store.js";
import { retrieveTool } from "../tools/retrieve.js";
import { ConversationState } from "../agent/conversation.js";
import type { ContentBlock } from "../providers/types.js";

function payload(words: number): string {
  const bank = ["const", "value", "return", "result", "import", "export", "handler", "config"];
  let out = "";
  for (let i = 0; i < words; i++) out += bank[i % bank.length] + " ";
  return out;
}

function buildConversation(cycles: number, resultWords = 800): ConversationState {
  const convo = new ConversationState();
  convo.setModel("claude-sonnet-4-5");
  for (let i = 0; i < cycles; i++) {
    convo.addUserMessage(`question ${i}`);
    convo.addAssistantMessage([
      { type: "tool_use", toolCallId: `call-${i}`, toolName: "read_file", toolInput: { path: `f${i}.ts` } } as ContentBlock,
    ]);
    convo.addToolResults([
      { type: "tool_result", toolCallId: `call-${i}`, toolResult: `UNIQUE-${i} ` + payload(resultWords) } as ContentBlock,
    ]);
  }
  return convo;
}

describe("ClearedStore", () => {
  it("stores and retrieves originals by id", () => {
    const store = new ClearedStore();
    const id = store.put("the original text");
    expect(store.get(id)).toBe("the original text");
  });

  it("returns undefined for unknown ids", () => {
    const store = new ClearedStore();
    expect(store.get("nope")).toBeUndefined();
  });

  it("evicts the oldest entry past capacity", () => {
    const store = new ClearedStore(2);
    const a = store.put("A");
    const b = store.put("B");
    const c = store.put("C"); // evicts A
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBe("B");
    expect(store.get(c)).toBe("C");
  });
});

describe("retrieve tool", () => {
  beforeEach(() => clearedStore.clear());

  it("errors when id is missing", async () => {
    const r = await retrieveTool.execute({});
    expect(r.isError).toBe(true);
  });

  it("errors with a helpful message for an unknown id", async () => {
    const r = await retrieveTool.execute({ id: "cleared-999" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("Re-run the tool");
  });

  it("returns the exact stored original", async () => {
    const id = clearedStore.put("exact original bytes");
    const r = await retrieveTool.execute({ id });
    expect(r.isError).toBe(false);
    expect(r.output).toBe("exact original bytes");
  });
});

describe("CCR round-trip: clear then retrieve", () => {
  beforeEach(() => clearedStore.clear());

  it("cleared placeholder references a retrieve id that returns the original", async () => {
    const convo = buildConversation(10);
    // Capture the originals before clearing.
    const originals = convo
      .getMessages()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => b.toolResult!);

    const freed = convo.clearStaleToolResults({ keepRecentResults: 2, minClearChars: 2000 });
    expect(freed).toBeGreaterThan(0);

    // Find a cleared placeholder and pull its retrieve id.
    const cleared = convo
      .getMessages()
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result" && b.toolResultCleared);
    expect(cleared).toBeDefined();

    const match = /retrieve\(\{ id: "([^"]+)" \}\)/.exec(cleared!.toolResult ?? "");
    expect(match, "placeholder should contain a retrieve id").not.toBeNull();
    const id = match![1]!;

    const r = await retrieveTool.execute({ id });
    expect(r.isError).toBe(false);
    // The retrieved text is one of the exact originals we started with.
    expect(originals).toContain(r.output);
  });
});
