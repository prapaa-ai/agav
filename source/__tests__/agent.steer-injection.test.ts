import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import { drainSteers, queueSteer } from "../commands/steer.js";
import { STEER_DIRECTIVE_PREFIX } from "../agent/internal-prompts.js";
import type { LLMProvider, Message, StreamEvent, StreamParams } from "../providers/types.js";
import type { ToolDefinition } from "../tools/types.js";

/**
 * Provider whose first stream emits a tool call and whose later streams block
 * on a gate before finishing, so the test can queue a /steer directive at a
 * deterministic moment while the turn is still running.
 */
class GatedProvider implements LLMProvider {
  name = "mock";
  calls: StreamParams[] = [];
  constructor(private readonly gate: Promise<void>) {}

  async *stream(params: StreamParams): AsyncGenerator<StreamEvent> {
    this.calls.push(params);
    if (this.calls.length === 1) {
      yield { type: "tool_call_start" as const, toolCallId: "tc_1", toolName: "gate_tool" };
      yield { type: "tool_call_delta" as const, toolCallId: "tc_1", argsJson: "{}" };
      yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
    } else {
      yield { type: "text_delta" as const, text: "acknowledged" };
      yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
      await this.gate;
    }
  }
}

async function collect(loop: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop) events.push(event);
  return events;
}

/** Text of every user-turn text block, flattened in order. */
function userTexts(messages: Message[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text) texts.push(block.text);
    }
  }
  return texts;
}

describe("mid-turn steer delivery", () => {
  it("delivers a steer queued mid-turn to the same running agent loop", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });

    const gateTool: ToolDefinition = {
      schema: {
        name: "gate_tool",
        description: "Blocks until released",
        destructive: false,
        inputSchema: { type: "object", properties: {} },
      },
      execute: vi.fn(async () => {
        await gate;
        return { output: "released", isError: false };
      }),
    };

    const provider = new GatedProvider(gate);
    const registry = new ToolRegistry();
    registry.register(gateTool);

    const conversation = new ConversationState();
    conversation.addUserMessage("start the long task");

    const events: AgentEvent[] = [];
    const finished = (async () => {
      for await (const event of runAgentLoop({
        provider,
        conversation,
        toolRegistry: registry,
        model: "mock",
        permissionMode: "auto-accept",
        maxIterations: 3,
        drainSteers,
      })) {
        events.push(event);
      }
    })();

    // Wait until the gated tool is executing, then steer exactly like the
    // slash command does while the turn is in flight.
    while (vi.mocked(gateTool.execute).mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    queueSteer("focus on the parser");
    releaseGate();
    await finished;

    // A second provider round happened and saw the directive.
    expect(provider.calls.length).toBe(2);
    const texts = userTexts(provider.calls[1]!.messages);
    expect(texts.some((t) => t.includes(STEER_DIRECTIVE_PREFIX) && t.includes("focus on the parser"))).toBe(true);

    // Protocol safety: the steer never lands between the assistant tool_use
    // and its matching tool_result — it comes right after the tool results.
    const messages = provider.calls[1]!.messages;
    const toolUseIndex = messages.findIndex(
      (msg) => msg.role === "assistant" && msg.content.some((b) => b.type === "tool_use"),
    );
    expect(toolUseIndex).toBeGreaterThanOrEqual(0);
    expect(messages[toolUseIndex + 1]!.role).toBe("user");
    expect(messages[toolUseIndex + 1]!.content.some((b) => b.type === "tool_result")).toBe(true);
    expect(messages[toolUseIndex + 2]!.role).toBe("user");
    expect(messages[toolUseIndex + 2]!.content[0]).toMatchObject({ type: "text" });
    expect((messages[toolUseIndex + 2]!.content[0] as { text?: string }).text).toContain(STEER_DIRECTIVE_PREFIX);

    // The UI is told the steer was delivered, and the queue is left empty.
    const applied = events.find((e) => e.type === "steer_applied") as Extract<AgentEvent, { type: "steer_applied" }> | undefined;
    expect(applied?.directives).toEqual(["focus on the parser"]);
    expect(drainSteers()).toEqual([]);
  });

  it("flushes a steer queued during the final response instead of dropping it", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });

    const fastTool: ToolDefinition = {
      schema: {
        name: "fast_tool",
        description: "Returns immediately",
        destructive: false,
        inputSchema: { type: "object", properties: {} },
      },
      execute: vi.fn(async () => ({ output: "ok", isError: false })),
    };

    const provider = new GatedProvider(gate);
    const registry = new ToolRegistry();
    registry.register(fastTool);

    const conversation = new ConversationState();
    conversation.addUserMessage("do it");

    // The loop blocks inside the second (final, tool-free) stream; steering
    // there means the directive arrives after the last tool round, when the
    // loop is about to exit without another safe point.
    const events: AgentEvent[] = [];
    const finished = (async () => {
      for await (const event of runAgentLoop({
        provider,
        conversation,
        toolRegistry: registry,
        model: "mock",
        permissionMode: "auto-accept",
        maxIterations: 3,
        drainSteers,
      })) {
        events.push(event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 20));
    queueSteer("wrap up early");
    releaseGate();
    await finished;

    const applied = events.find((e) => e.type === "steer_applied") as Extract<AgentEvent, { type: "steer_applied" }> | undefined;
    expect(applied?.directives).toEqual(["wrap up early"]);

    const tail = conversation.getMessages().at(-1)!;
    expect(tail.role).toBe("user");
    expect(tail.internal).toBe(true);
    expect(userTexts([tail])[0]).toContain("wrap up early");

    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    expect(drainSteers()).toEqual([]);
  });
});

describe("injectUserMessage placement", () => {
  it("never inserts between an unanswered tool_use and its tool_result", async () => {
    const { ConversationState } = await import("../agent/conversation.js");
    const convo = new ConversationState();

    convo.addUserMessage("run the thing");
    convo.addAssistantMessage([
      { type: "text", text: "working" },
      { type: "tool_use", toolCallId: "t1", toolName: "shell", toolInput: {} },
    ]);

    convo.injectUserMessage("mid-turn note");

    const messages = convo.getMessages();
    // Slides back to before the pending assistant turn rather than wedging
    // into the cycle: [user, note, assistant(tool_use…)] keeps every
    // tool_use immediately answered once its result lands.
    expect(messages).toHaveLength(3);
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.internal).toBe(true);
    expect((messages[1]!.content[0] as { text?: string }).text).toBe("mid-turn note");
    expect(messages[2]!.role).toBe("assistant");
    expect(messages[2]!.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("inserts before a trailing pending assistant turn when earlier cycles are complete", async () => {
    const { ConversationState } = await import("../agent/conversation.js");
    const convo = new ConversationState();

    convo.addUserMessage("go");
    convo.addAssistantMessage([{ type: "tool_use", toolCallId: "t1", toolName: "shell", toolInput: {} }]);
    convo.addToolResults([{ type: "tool_result", toolCallId: "t1", toolResult: "ok" }]);
    convo.addAssistantMessage([{ type: "tool_use", toolCallId: "t2", toolName: "shell", toolInput: {} }]);

    convo.injectUserMessage("mid-turn note");

    const messages = convo.getMessages();
    // Lands between the answered cycle and the pending one — legal for providers,
    // whereas landing after t2's tool_use would be rejected.
    expect(messages).toHaveLength(5);
    expect((messages[3]!.content[0] as { text?: string }).text).toBe("mid-turn note");
    expect(messages[4]!.role).toBe("assistant");
  });

  it("appends to an empty or plain-text history", async () => {
    const { ConversationState } = await import("../agent/conversation.js");
    const empty = new ConversationState();
    empty.injectUserMessage("first note");
    expect(empty.getMessages()).toHaveLength(1);
    expect(empty.getMessages()[0]!.role).toBe("user");

    const plain = new ConversationState();
    plain.addUserMessage("hi");
    plain.addAssistantMessage([{ type: "text", text: "hello" }]);
    plain.injectUserMessage("note");
    expect(plain.getMessages()).toHaveLength(3);
    expect(plain.getMessages()[2]!.role).toBe("user");
  });

  it("ignores blank directives", async () => {
    const { ConversationState } = await import("../agent/conversation.js");
    const convo = new ConversationState();
    convo.addUserMessage("hi");
    convo.injectUserMessage("   ");
    expect(convo.getMessages()).toHaveLength(1);
  });
});

describe("steer queue plumbing", () => {
  it("drains queued directives in order and empties the queue", () => {
    queueSteer("one");
    queueSteer("two");
    expect(drainSteers()).toEqual(["one", "two"]);
    expect(drainSteers()).toEqual([]);
  });

  it("loops without drainSteers (subagents/skills) never consume queued directives", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });

    const gateTool: ToolDefinition = {
      schema: {
        name: "gate_tool",
        description: "Blocks until released",
        destructive: false,
        inputSchema: { type: "object", properties: {} },
      },
      execute: vi.fn(async () => {
        await gate;
        return { output: "released", isError: false };
      }),
    };

    const provider = new GatedProvider(gate);
    const registry = new ToolRegistry();
    registry.register(gateTool);

    const conversation = new ConversationState();
    conversation.addUserMessage("subagent task");

    const events: AgentEvent[] = [];
    const finished = (async () => {
      for await (const event of runAgentLoop({
        provider,
        conversation,
        toolRegistry: registry,
        model: "mock",
        permissionMode: "auto-accept",
        maxIterations: 3,
        // No drainSteers — this is how subagent/skill/agent loops run.
      })) {
        events.push(event);
      }
    })();

    while (vi.mocked(gateTool.execute).mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // A directive meant for the main agent is queued while the subagent runs.
    queueSteer("for the main agent only");
    releaseGate();
    await finished;

    // The subagent loop neither injected the directive nor reported delivery…
    expect(events.some((e) => e.type === "steer_applied")).toBe(false);
    const texts = userTexts(conversation.getMessages());
    expect(texts.every((t) => !t.includes("for the main agent only"))).toBe(true);

    // …and the directive survives for the main loop to pick up.
    expect(drainSteers()).toEqual(["for the main agent only"]);
  });
});
