import { describe, expect, it, vi } from "vitest";
import { RetryProvider } from "../providers/retry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";

function createMockProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: "mock-provider",
    stream: vi.fn(async function* () {
      yield { type: "text_delta" as const, text: "hello" };
    }),
    ...overrides,
  };
}

describe("RetryProvider capability forwarding", () => {
  it("forwards getContextWindow when implemented by inner provider", async () => {
    const inner = createMockProvider({
      name: "openrouter",
      getContextWindow: vi.fn().mockResolvedValue(128000),
    });

    const retry = new RetryProvider(inner);

    expect(retry.getContextWindow).toBeTypeOf("function");
    const result = await retry.getContextWindow!("anthropic/claude-sonnet-4.5");
    expect(result).toBe(128000);
    expect(inner.getContextWindow).toHaveBeenCalledWith("anthropic/claude-sonnet-4.5");
  });

  it("leaves getContextWindow undefined when inner provider does not implement it", () => {
    const inner = createMockProvider({ name: "anthropic" });
    delete inner.getContextWindow;

    const retry = new RetryProvider(inner);

    expect(retry.getContextWindow).toBeUndefined();
  });

  it("forwards the provider name", () => {
    const inner = createMockProvider({ name: "openrouter" });
    const retry = new RetryProvider(inner);
    expect(retry.name).toBe("openrouter");
  });
});

describe("RetryProvider stream and error retries", () => {
  const dummyParams: StreamParams = {
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
  };

  it("streams normally when no errors occur", async () => {
    const inner = createMockProvider({
      stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "message_start" };
        yield { type: "text_delta", text: "result" };
        yield { type: "message_end", stopReason: "stop" };
      }),
    });

    const retry = new RetryProvider(inner);
    const events: StreamEvent[] = [];
    for await (const ev of retry.stream(dummyParams)) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: "message_start" },
      { type: "text_delta", text: "result" },
      { type: "message_end", stopReason: "stop" },
    ]);
  });

  it("retries on retryable errors and succeeds when next attempt passes", async () => {
    let attempts = 0;
    const inner = createMockProvider({
      stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        attempts++;
        if (attempts === 1) {
          const err: any = new Error("Rate limited");
          err.status = 429;
          throw err;
        }
        yield { type: "text_delta", text: "recovered" };
      }),
    });

    const retry = new RetryProvider(inner, 2);
    const events: StreamEvent[] = [];
    for await (const ev of retry.stream(dummyParams)) {
      events.push(ev);
    }

    expect(attempts).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.text === "recovered")).toBe(true);
  });

  it("throws non-retryable error immediately", async () => {
    let attempts = 0;
    const inner = createMockProvider({
      stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        attempts++;
        const err: any = new Error("Invalid request");
        err.status = 400;
        throw err;
      }),
    });

    const retry = new RetryProvider(inner, 3);
    await expect(async () => {
      for await (const _ of retry.stream(dummyParams)) {
        // drain
      }
    }).rejects.toThrow("Invalid request");

    expect(attempts).toBe(1);
  });
});
