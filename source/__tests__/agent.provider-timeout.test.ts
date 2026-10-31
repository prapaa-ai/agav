import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop, ProviderIdleTimeoutError, type AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import { RetryProvider } from "../providers/retry.js";
import type { ToolDefinition } from "../tools/types.js";
import { validateProviderIdleTimeout } from "../config/config.js";
import { parseArgs } from "../main.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, _val?: unknown, options?: { signal?: AbortSignal }) => {
    return new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        return reject(options.signal.reason ?? new Error("Aborted"));
      }
      const timer = setTimeout(() => {
        options?.signal?.removeEventListener("abort", onAbort);
        resolve(_val);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(options?.signal?.reason ?? new Error("Aborted"));
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
}));

async function collectEvents(loop: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop) {
    events.push(event);
  }
  return events;
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new Error("Aborted"));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

describe("provider response idle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("times out when no first event is received within the configured interval", async () => {
    let capturedSignal: AbortSignal | undefined;
    let streamCallCount = 0;

    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        streamCallCount++;
        capturedSignal = params.signal;
        return (async function* (): AsyncGenerator<StreamEvent> {
          await delayWithSignal(5000, params.signal);
          yield { type: "message_end", stopReason: "end_turn" };
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.addUserMessage("Hello");
    const toolRegistry = new ToolRegistry();

    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 100,
    }));

    await vi.advanceTimersByTimeAsync(100);
    const events = await loopPromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBeInstanceOf(ProviderIdleTimeoutError);
    expect(streamCallCount).toBe(1); // zero automatic fallback or retry calls

    const lastEvent = events.at(-1);
    expect(lastEvent).toEqual({
      type: "error",
      error: expect.any(ProviderIdleTimeoutError),
      reason: "provider_idle_timeout",
    });
    expect((lastEvent as any).error.message).toContain("Provider response idle timeout after 100ms");

    // Conversation should not have any empty assistant message
    expect(conversation.getMessages()).toHaveLength(1);
    expect(conversation.getMessages()[0]!.role).toBe("user");
  });

  it("stalls after partial text and incomplete tool call, preserving text and dropping partial tool", async () => {
    let capturedSignal: AbortSignal | undefined;

    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        capturedSignal = params.signal;
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", text: "I have begun inspecting the issue." };
          yield { type: "tool_call_start", toolCallId: "call_incomplete", toolName: "write_file" };
          yield { type: "tool_call_delta", toolCallId: "call_incomplete", argsJson: '{"path": "incomplete.txt' };
          // Stalls mid-response
          await delayWithSignal(5000, params.signal);
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.addUserMessage("Fix the bug");
    const toolRegistry = new ToolRegistry();

    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 150,
    }));

    await vi.advanceTimersByTimeAsync(150);
    const events = await loopPromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBeInstanceOf(ProviderIdleTimeoutError);

    // Should yield streaming_text, then assistant_message_complete with partial text, then error
    expect(events).toContainEqual({
      type: "assistant_message_complete",
      text: "I have begun inspecting the issue.",
    });
    expect(events.at(-1)).toEqual({
      type: "error",
      error: expect.any(ProviderIdleTimeoutError),
      reason: "provider_idle_timeout",
    });

    // Transcript safety: conversation must have preserved partial text
    const msgs = conversation.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content).toEqual([
      { type: "text", text: "I have begun inspecting the issue." },
    ]);
    // Must NOT have emitted or stored the incomplete tool_use block
    expect(msgs[1]!.content.some(c => c.type === "tool_use")).toBe(false);
  });

  it("does not abort active streams whose total duration exceeds idle threshold when events reset clock", async () => {
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        return (async function* (): AsyncGenerator<StreamEvent> {
          for (let i = 1; i <= 5; i++) {
            await delayWithSignal(40, params.signal);
            yield { type: "text_delta", text: `chunk-${i} ` };
          }
          yield { type: "message_end", stopReason: "end_turn" };
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.addUserMessage("Stream tokens");
    const toolRegistry = new ToolRegistry();

    // Idle timeout is 60ms; total duration is 5 * 40 = 200ms (> 60ms)
    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 60,
    }));

    // Advance 40ms 5 times
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(40);
    }
    const events = await loopPromise;

    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "turn_complete" });
    expect(conversation.getMessages().at(-1)?.content).toEqual([
      { type: "text", text: "chunk-1 chunk-2 chunk-3 chunk-4 chunk-5 " },
    ]);
  });

  it("completes cleanly when stream finishes just before idle expiry", async () => {
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        return (async function* (): AsyncGenerator<StreamEvent> {
          await delayWithSignal(90, params.signal);
          yield { type: "text_delta", text: "done just in time" };
          yield { type: "message_end", stopReason: "end_turn" };
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.addUserMessage("Quick reply");
    const toolRegistry = new ToolRegistry();

    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 100,
    }));

    await vi.advanceTimersByTimeAsync(90);
    const events = await loopPromise;

    // Advance further past 100ms — timer must have been cleared on completion
    await vi.advanceTimersByTimeAsync(100);

    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "turn_complete" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves SDK defaults without adding a timer when setting is disabled or unset", async () => {
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        return (async function* (): AsyncGenerator<StreamEvent> {
          await delayWithSignal(1000, params.signal);
          yield { type: "text_delta", text: "unhurried response" };
          yield { type: "message_end", stopReason: "end_turn" };
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.addUserMessage("Take your time");
    const toolRegistry = new ToolRegistry();

    // providerIdleTimeout unset
    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: undefined,
    }));

    expect(vi.getTimerCount()).toBe(0); // No timer was added by Agav

    await vi.advanceTimersByTimeAsync(1000);
    const events = await loopPromise;

    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "turn_complete" });
  });

  it("distinguishes explicit user cancellation (Esc) from timeout", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        capturedSignal = params.signal;
        return (async function* (): AsyncGenerator<StreamEvent> {
          await delayWithSignal(1000, params.signal);
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.addUserMessage("Stop me");
    const toolRegistry = new ToolRegistry();

    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 500,
      signal: controller.signal,
    }));

    // User cancels at 100ms (before 500ms timeout)
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error("User cancelled"));

    const events = await loopPromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).not.toBeInstanceOf(ProviderIdleTimeoutError);

    // The event should be the standard Aborted error, not provider_idle_timeout
    const errorEvent = events.find(e => e.type === "error");
    expect(errorEvent).toEqual({ type: "error", error: new Error("Aborted") });
    expect((errorEvent as any)?.reason).toBeUndefined();

    // Verify timers were cleaned up
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows subsequent successful prompt submission after a timeout occurs", async () => {
    let call = 0;
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        call++;
        if (call === 1) {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text_delta", text: "Stalling..." };
            await delayWithSignal(5000, params.signal);
          })();
        }
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", text: "Recovered and working normally!" };
          yield { type: "message_end", stopReason: "end_turn" };
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.addUserMessage("First attempt");
    const toolRegistry = new ToolRegistry();

    // Turn 1 times out
    const turn1Promise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 100,
    }));
    await vi.advanceTimersByTimeAsync(100);
    const turn1Events = await turn1Promise;

    expect(turn1Events.at(-1)).toEqual(expect.objectContaining({
      type: "error",
      reason: "provider_idle_timeout",
    }));

    // Turn 2: User submits a subsequent prompt on the same conversation
    conversation.addUserMessage("Try again please");
    const turn2Promise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 100,
    }));

    const turn2Events = await turn2Promise;
    expect(turn2Events.some(e => e.type === "error")).toBe(false);
    expect(turn2Events).toContainEqual({ type: "turn_complete" });

    // Verify complete conversation history is well-formed
    const messages = conversation.getMessages();
    expect(messages).toHaveLength(4);
    expect(messages[0]!.content).toEqual([{ type: "text", text: "First attempt" }]);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "Stalling..." }]);
    expect(messages[2]!.content).toEqual([{ type: "text", text: "Try again please" }]);
    expect(messages[3]!.content).toEqual([{ type: "text", text: "Recovered and working normally!" }]);
  });

  it("does not count pending tool approval and execution time against the provider idle clock", async () => {
    let streamCount = 0;
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        streamCount++;
        if (streamCount === 1) {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "tool_call_start", toolCallId: "call_1", toolName: "long_task" };
            yield { type: "tool_call_delta", toolCallId: "call_1", argsJson: "{}" };
            yield { type: "message_end", stopReason: "tool_calls" };
          })();
        }
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", text: "Task completed successfully" };
          yield { type: "message_end", stopReason: "end_turn" };
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.addUserMessage("Run long task");
    const toolRegistry = new ToolRegistry();

    const toolDef: ToolDefinition = {
      schema: { name: "long_task", description: "long task", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => {
        // Tool execution takes 200ms (> 80ms timeout)
        await delayWithSignal(200);
        return { output: "result from long task", isError: false };
      }),
    };
    toolRegistry.register(toolDef);

    // User approval takes 200ms (> 80ms timeout)
    const confirmTool = vi.fn(async () => {
      await delayWithSignal(200);
      return "yes" as const;
    });

    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 2, total: 2 },
      providerIdleTimeout: 80,
      confirmTool,
      permissionMode: "ask",
    }));

    // Advance time through approval (200ms) and execution (200ms)
    await vi.advanceTimersByTimeAsync(500);
    const events = await loopPromise;

    expect(confirmTool).toHaveBeenCalledTimes(1);
    expect(toolDef.execute).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "turn_complete" });
    expect(conversation.getMessages().at(-1)?.content).toEqual([
      { type: "text", text: "Task completed successfully" },
    ]);
  });

  it("removes all timers and abort listeners on normal completion, timeout, cancel, and provider error", async () => {
    // 1. Success exit
    const successProvider: LLMProvider = {
      name: "mock",
      stream: () => (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn" };
      })(),
    };
    const parentSignal = new AbortController().signal;
    const addSpy = vi.spyOn(parentSignal, "addEventListener");
    const removeSpy = vi.spyOn(parentSignal, "removeEventListener");

    await collectEvents(runAgentLoop({
      provider: successProvider,
      conversation: new ConversationState(),
      toolRegistry: new ToolRegistry(),
      model: "test",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 100,
      signal: parentSignal,
    }));
    expect(addSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // 2. Provider error exit
    const errorProvider: LLMProvider = {
      name: "mock",
      stream: () => (async function* (): AsyncGenerator<StreamEvent> {
        throw new Error("API Failure");
      })(),
    };
    const errSignal = new AbortController().signal;
    const errRemoveSpy = vi.spyOn(errSignal, "removeEventListener");
    await collectEvents(runAgentLoop({
      provider: errorProvider,
      conversation: new ConversationState(),
      toolRegistry: new ToolRegistry(),
      model: "test",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 100,
      signal: errSignal,
    }));
    expect(errRemoveSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from context-length error while idle timer is pending without swallowing it as timeout", async () => {
    let requests = 0;
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => (async function* (): AsyncGenerator<StreamEvent> {
        requests++;
        if (params.systemPrompt?.startsWith("Summarize this conversation")) {
          yield { type: "text_delta", text: "Compacted summary of earlier messages." };
          yield { type: "message_end", stopReason: "end_turn" };
          return;
        }
        if (requests === 1) {
          // Immediately throws context overflow before the 500ms idle timer expires
          throw new Error("context window exceeded: maximum tokens reached");
        }
        // After compaction recovery, request 2 completes normally
        yield { type: "text_delta", text: "Successfully answered after compaction recovery!" };
        yield { type: "message_end", stopReason: "end_turn" };
      })()),
    };

    const conversation = new ConversationState();
    conversation.setModel("mock");
    conversation.setContextWindow(1000);
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) conversation.addUserMessage("context ".repeat(100));
      else conversation.addAssistantMessage([{ type: "text", text: "response ".repeat(100) }]);
    }

    const events = await collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry: new ToolRegistry(),
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 500,
    }));

    // Must NOT have timed out — should recover via compaction and complete turn
    expect(events.some(e => e.type === "error" && (e as any).reason === "provider_idle_timeout")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "compacted" }));
    expect(events).toContainEqual({ type: "turn_complete" });
    expect(conversation.getMessages().at(-1)?.content).toEqual([
      { type: "text", text: "Successfully answered after compaction recovery!" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops incomplete tool calls and reports timeout when stream ends normally on abort without throwing (OpenAI behavior)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const toolExecuted = vi.fn();

    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        capturedSignal = params.signal;
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", text: "Partial reasoning " };
          yield { type: "tool_call_start", toolCallId: "call_incomplete", toolName: "dangerous_exec" };
          yield { type: "tool_call_delta", toolCallId: "call_incomplete", argsJson: '{"cmd":"rm -rf /' };

          // Wait for abort signal from idle timeout, then return cleanly without throwing (like OpenAI SDK)
          await new Promise<void>((resolve) => {
            if (params.signal?.aborted) return resolve();
            params.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // Generator finishes cleanly without throw
        })();
      }),
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      schema: {
        name: "dangerous_exec",
        description: "A dangerous tool that must not run on partial input",
        inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
      },
      execute: toolExecuted,
    });

    const conversation = new ConversationState();
    conversation.addUserMessage("Delete files");

    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 100,
    }));

    await vi.advanceTimersByTimeAsync(100);
    const events = await loopPromise;

    // Verify tool was NOT dispatched
    expect(toolExecuted).not.toHaveBeenCalled();

    // Verify timeout error is reported, not turn_complete
    expect(events.some(e => e.type === "turn_complete")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "error",
      error: expect.any(ProviderIdleTimeoutError),
      reason: "provider_idle_timeout",
    });

    // Verify partial text was committed
    expect(conversation.getMessages()).toEqual([
      { role: "user", content: [{ type: "text", text: "Delete files" }] },
      { role: "assistant", content: [{ type: "text", text: "Partial reasoning " }] },
    ]);
  });

  it("drops incomplete tool calls and reports abort when stream ends normally on user cancellation without throwing", async () => {
    const toolExecuted = vi.fn();
    const abortController = new AbortController();

    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "tool_call_start", toolCallId: "call_incomplete", toolName: "dangerous_exec" };
          yield { type: "tool_call_delta", toolCallId: "call_incomplete", argsJson: '{"cmd":"delete' };

          await new Promise<void>((resolve) => {
            if (params.signal?.aborted) return resolve();
            params.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // Clean return on abort without throwing
        })();
      }),
    };

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      schema: {
        name: "dangerous_exec",
        description: "A dangerous tool",
        inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
      },
      execute: toolExecuted,
    });

    const conversation = new ConversationState();
    conversation.addUserMessage("Run cmd");

    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 5000,
      signal: abortController.signal,
    }));

    // Trigger user cancellation (e.g. Esc)
    abortController.abort(new Error("Aborted by user"));
    const events = await loopPromise;

    expect(toolExecuted).not.toHaveBeenCalled();
    expect(events.some(e => e.type === "turn_complete")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "error",
      error: expect.any(Error),
    });
  });

  it("pauses idle timer during RetryProvider backoff sleep and rearms when next attempt begins", async () => {
    let attemptCount = 0;
    const innerProvider: LLMProvider = {
      name: "inner-mock",
      stream: vi.fn((params: StreamParams) => {
        const currentAttempt = attemptCount++;
        return (async function* (): AsyncGenerator<StreamEvent> {
          if (currentAttempt === 0) {
            // Attempt 0 fails with a 429 Retry-After: 120 error
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err.headers = { "retry-after": "120" };
            throw err;
          }
          // Attempt 1 succeeds after the 120s backoff
          yield { type: "text_delta", text: "Successfully recovered after backoff!" };
          yield { type: "message_end", stopReason: "stop" };
        })();
      }),
    };

    const retryProvider = new RetryProvider(innerProvider, 3);
    const conversation = new ConversationState();
    conversation.addUserMessage("Hello");
    const toolRegistry = new ToolRegistry();

    const loopPromise = collectEvents(runAgentLoop({
      provider: retryProvider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 60_000, // 60s timeout, less than 120s backoff!
    }));

    // Advance 60s into the 120s backoff
    await vi.advanceTimersByTimeAsync(60_000);

    // Verify it did NOT time out during backoff
    expect(attemptCount).toBe(1);

    // Advance the remaining 60s of backoff (total 120s)
    await vi.advanceTimersByTimeAsync(60_000);
    const events = await loopPromise;

    expect(attemptCount).toBe(2);
    expect(events.some(e => e.type === "error" && (e as any).reason === "provider_idle_timeout")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "retry" }));
    expect(events).toContainEqual({ type: "turn_complete" });
    expect(conversation.getMessages().at(-1)?.content).toEqual([
      { type: "text", text: "Successfully recovered after backoff!" },
    ]);
  });

  it("rearmer catches stalled stream on retried attempt after backoff completes", async () => {
    let attemptCount = 0;
    let attempt1Signal: AbortSignal | undefined;

    const innerProvider: LLMProvider = {
      name: "inner-mock",
      stream: vi.fn((params: StreamParams) => {
        const currentAttempt = attemptCount++;
        return (async function* (): AsyncGenerator<StreamEvent> {
          if (currentAttempt === 0) {
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err.headers = { "retry-after": "10" };
            throw err;
          }
          // Attempt 1 begins after 10s backoff, but stalls before sending any event
          attempt1Signal = params.signal;
          await delayWithSignal(50_000, params.signal);
          yield { type: "message_end", stopReason: "stop" };
        })();
      }),
    };

    const retryProvider = new RetryProvider(innerProvider, 3);
    const conversation = new ConversationState();
    conversation.addUserMessage("Hello");
    const toolRegistry = new ToolRegistry();

    const loopPromise = collectEvents(runAgentLoop({
      provider: retryProvider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 5_000, // 5s timeout
    }));

    // Advance 10s: backoff completes, attempt 1 begins
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attemptCount).toBe(2);

    // Advance 5s: idle watchdog on attempt 1 expires
    await vi.advanceTimersByTimeAsync(5_000);
    const events = await loopPromise;

    expect(attempt1Signal?.aborted).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "error",
      error: expect.any(ProviderIdleTimeoutError),
      reason: "provider_idle_timeout",
    });
  });

  it("applies idle watchdog to stalled conversation summarization during compaction", async () => {
    let summarizeSignal: AbortSignal | undefined;

    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        if (params.systemPrompt?.includes("Summarize this conversation concisely")) {
          summarizeSignal = params.signal;
          return (async function* (): AsyncGenerator<StreamEvent> {
            // Stalled summarizer: never yields any text
            await delayWithSignal(50_000, params.signal);
            yield { type: "text_delta", text: "Summary text" };
            yield { type: "message_end", stopReason: "stop" };
          })();
        }
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", text: "Final answer after compaction" };
          yield { type: "message_end", stopReason: "stop" };
        })();
      }),
    };

    const conversation = new ConversationState();
    conversation.setModel("mock");
    conversation.setContextWindow(1000);
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) conversation.addUserMessage("context ".repeat(100));
      else conversation.addAssistantMessage([{ type: "text", text: "response ".repeat(100) }]);
    }
    conversation.addUserMessage("Latest query");
    const toolRegistry = new ToolRegistry();

    const loopPromise = collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "test-model",
      iterationsBudget: { remaining: 5, total: 5 },
      providerIdleTimeout: 1_000,
    }));

    // Advance timers so stalled summarizer times out after 1_000ms
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await loopPromise;

    expect(summarizeSignal?.aborted).toBe(true);
    expect(summarizeSignal?.reason).toBeInstanceOf(ProviderIdleTimeoutError);
    // Loop recovers and answers without hanging forever
    expect(events).toContainEqual({ type: "turn_complete" });
  });
});

describe("providerIdleTimeout configuration and CLI validation", () => {
  it("validates valid configuration values", () => {
    expect(validateProviderIdleTimeout(1000)).toBe(1000);
    expect(validateProviderIdleTimeout("30000")).toBe(30000);
    expect(validateProviderIdleTimeout(2147483647)).toBe(2147483647);
  });

  it("recognizes disabled and unset states", () => {
    expect(validateProviderIdleTimeout(undefined)).toBeUndefined();
    expect(validateProviderIdleTimeout(null)).toBeUndefined();
    expect(validateProviderIdleTimeout("disabled")).toBeUndefined();
    expect(validateProviderIdleTimeout("off")).toBeUndefined();
  });

  it.each([
    0,
    -100,
    2147483648, // exceeds 32-bit setTimeout limit
    12.5,
    "foo",
    "0",
    "-5",
    "",
    "   ",
    NaN,
    Infinity,
    true,
    {},
  ])("rejects invalid value %j with a clear error", (invalid) => {
    expect(() => validateProviderIdleTimeout(invalid)).toThrow(
      /providerIdleTimeout must be a positive integer in milliseconds \(1–2147483647\) or "disabled"/,
    );
  });

  it("parses CLI flags correctly", () => {
    expect(parseArgs(["--provider-idle-timeout", "5000"]).providerIdleTimeout).toBe(5000);
    expect(parseArgs(["--provider-idle-timeout=15000"]).providerIdleTimeout).toBe(15000);
    expect(parseArgs(["--provider-idle-timeout", "disabled"]).providerIdleTimeout).toBeNull();
    expect(parseArgs(["--provider-idle-timeout=off"]).providerIdleTimeout).toBeNull();
  });

  it.each([
    ["--provider-idle-timeout", "0"],
    ["--provider-idle-timeout", "-5"],
    ["--provider-idle-timeout", "2147483648"],
    ["--provider-idle-timeout", "abc"],
    ["--provider-idle-timeout", ""],
    ["--provider-idle-timeout"],
  ])("rejects invalid CLI flag arguments: %j", (...args) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => parseArgs(args)).toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--provider-idle-timeout"));

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
