import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyPoolManager, maskKey } from "../providers/key-pool.js";
import {
  AllKeysCoolingError,
  extractRetryAfterMs,
  isAuthError,
  isRateLimitError,
  KeyPoolProvider,
} from "../providers/key-pool-provider.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";

describe("KeyPoolManager", () => {
  beforeEach(() => {
    KeyPoolManager.resetInstance();
  });

  it("maintains a singleton instance and resets properly", () => {
    const manager1 = KeyPoolManager.getInstance();
    const manager2 = KeyPoolManager.getInstance();
    expect(manager1).toBe(manager2);

    manager1.registerKeys("anthropic", ["key-1"]);
    expect(manager1.getNextKey("anthropic")).not.toBeNull();

    KeyPoolManager.resetInstance();
    const manager3 = KeyPoolManager.getInstance();
    expect(manager3.getNextKey("anthropic")).toBeNull();
  });

  it("loads and cleans keys correctly, ignoring duplicates and whitespace", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("anthropic", [
      "  sk-ant-1  ",
      "sk-ant-2",
      "sk-ant-1", // duplicate
      "",         // empty
      "   ",      // whitespace
    ]);

    const status = manager.getPoolStatus("anthropic")["anthropic"];
    expect(status.totalKeys).toBe(2);
    expect(status.availableKeys).toBe(2);
    expect(status.keys).toHaveLength(2);
    expect(status.keys[0].key).toBe(maskKey("sk-ant-1"));
    expect(status.keys[1].key).toBe(maskKey("sk-ant-2"));
  });

  it("handles empty or invalid registration gracefully", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("empty-provider", []);
    expect(manager.getNextKey("empty-provider")).toBeNull();

    // @ts-expect-error testing invalid argument
    manager.registerKeys("invalid-provider", null);
    expect(manager.getNextKey("invalid-provider")).toBeNull();

    expect(manager.getNextKey("non-existent")).toBeNull();
  });

  it("rotates keys in round-robin sequence under normal conditions", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("openai", ["key-1", "key-2", "key-3"]);

    const k1 = manager.getNextKey("openai");
    manager.reportSuccess("openai", k1!.key);

    const k2 = manager.getNextKey("openai");
    manager.reportSuccess("openai", k2!.key);

    const k3 = manager.getNextKey("openai");
    manager.reportSuccess("openai", k3!.key);

    const k4 = manager.getNextKey("openai");
    manager.reportSuccess("openai", k4!.key);

    expect(k1?.key).toBe("key-1");
    expect(k2?.key).toBe("key-2");
    expect(k3?.key).toBe("key-3");
    expect(k4?.key).toBe("key-1");
  });

  it("prefers least busy keys when active requests differ", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("openai", ["key-1", "key-2"]);

    // Key 1 taken, activeRequests becomes 1
    const k1 = manager.getNextKey("openai");
    expect(k1?.key).toBe("key-1");

    // Key 2 has 0 active requests, so it should be chosen next
    const k2 = manager.getNextKey("openai");
    expect(k2?.key).toBe("key-2");

    // Both now have 1 active request. Next request rotates back to key-1
    const k3 = manager.getNextKey("openai");
    expect(k3?.key).toBe("key-1");

    // Release k2
    manager.reportSuccess("openai", k2!.key);

    // Now key-2 has 0 active requests while key-1 has 2, so key-2 is picked
    const k4 = manager.getNextKey("openai");
    expect(k4?.key).toBe("key-2");
  });

  it("skips disabled keys and includes them again when re-enabled", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("gemini", ["key-1", "key-2", "key-3"]);

    // Disable index 1 ("key-2")
    manager.enableKey("gemini", 1, false);

    const k1 = manager.getNextKey("gemini");
    manager.reportSuccess("gemini", k1!.key);

    const k2 = manager.getNextKey("gemini");
    manager.reportSuccess("gemini", k2!.key);

    expect(k1?.key).toBe("key-1");
    expect(k2?.key).toBe("key-3"); // skipped key-2!

    // Re-enable index 1
    manager.enableKey("gemini", 1, true);

    const k3 = manager.getNextKey("gemini");
    manager.reportSuccess("gemini", k3!.key);

    const k4 = manager.getNextKey("gemini");
    manager.reportSuccess("gemini", k4!.key);

    expect(k3?.key).toBe("key-1");
    expect(k4?.key).toBe("key-2");
  });

  it("handles rate-limit cooldown and recovers after expiration", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("anthropic", ["key-1", "key-2"]);

    // Key 1 fails with rate limit and 50ms cooldown
    manager.reportFailure("anthropic", "key-1", new Error("Rate limited"), 50);

    // key-1 is now cooling, so getNextKey must return key-2
    const next1 = manager.getNextKey("anthropic");
    expect(next1?.key).toBe("key-2");

    // Next request should also return key-2 because key-1 is still cooling
    const next2 = manager.getNextKey("anthropic");
    expect(next2?.key).toBe("key-2");

    // Check status reports cooling
    const status = manager.getPoolStatus("anthropic")["anthropic"];
    expect(status.coolingKeys).toBe(1);
    expect(status.keys[0].isCooling).toBe(true);
    expect(status.keys[1].isCooling).toBe(false);

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 70));

    manager.reportSuccess("anthropic", "key-2");
    manager.reportSuccess("anthropic", "key-2");

    // key-1 cooldown has expired, it should be available again
    const recovered = manager.getNextKey("anthropic");
    expect(recovered?.key).toBe("key-1");
  });

  it("applies exponential backoff on consecutive failures", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("deepseek", ["key-1"]);

    const now = Date.now();
    manager.reportFailure("deepseek", "key-1", new Error("Error 1"));
    let status = manager.getPoolStatus("deepseek")["deepseek"];
    expect(status.keys[0].consecutiveFailures).toBe(1);
    // 1st failure backoff is 1000ms
    expect(status.keys[0].coolingUntil).toBeGreaterThanOrEqual(now + 900);

    manager.reportFailure("deepseek", "key-1", new Error("Error 2"));
    status = manager.getPoolStatus("deepseek")["deepseek"];
    expect(status.keys[0].consecutiveFailures).toBe(2);
    // 2nd failure backoff is 2000ms
    expect(status.keys[0].coolingUntil).toBeGreaterThanOrEqual(now + 1900);
  });

  it("returns null when all keys are unavailable (cooling or disabled)", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("nvidia", ["key-1", "key-2"]);

    manager.reportFailure("nvidia", "key-1", new Error("Rate limit"), 10000);
    manager.enableKey("nvidia", 1, false); // key-2 disabled

    expect(manager.getNextKey("nvidia")).toBeNull();
  });

  it("manages concurrent key selections correctly without race conditions", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("openai", ["key-1", "key-2", "key-3"]);

    // Run 6 concurrent selections
    const selections = await Promise.all([
      Promise.resolve(manager.getNextKey("openai")),
      Promise.resolve(manager.getNextKey("openai")),
      Promise.resolve(manager.getNextKey("openai")),
      Promise.resolve(manager.getNextKey("openai")),
      Promise.resolve(manager.getNextKey("openai")),
      Promise.resolve(manager.getNextKey("openai")),
    ]);

    const keys = selections.map((s) => s?.key);
    expect(keys.filter((k) => k === "key-1")).toHaveLength(2);
    expect(keys.filter((k) => k === "key-2")).toHaveLength(2);
    expect(keys.filter((k) => k === "key-3")).toHaveLength(2);
  });

  it("redacts/masks all keys in status reporting", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("anthropic", [
      "sk-ant-api03-abcdef1234",
      "nvapi-9876543210",
      "short",
    ]);

    expect(maskKey("sk-ant-api03-abcdef1234")).toBe("sk-...1234");
    expect(maskKey("nvapi-9876543210")).toBe("nva...3210");
    expect(maskKey("short")).toBe("***");

    const status = manager.getPoolStatus("anthropic")["anthropic"];
    for (const keySlot of status.keys) {
      expect(keySlot.key).not.toContain("abcdef");
      expect(keySlot.key).not.toContain("9876543210");
    }
  });
});

describe("KeyPoolProvider", () => {
  beforeEach(() => {
    KeyPoolManager.resetInstance();
  });

  const dummyParams: StreamParams = {
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };

  it("rotates keys and successfully streams output", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("test-provider", ["key-1", "key-2"]);

    const createdKeys: string[] = [];
    const factory = (key: string): LLMProvider => ({
      name: "test-provider",
      stream: vi.fn(async function* () {
        createdKeys.push(key);
        yield { type: "text_delta" as const, text: `from-${key}` };
      }),
    });

    const provider = new KeyPoolProvider("test-provider", factory, { keyPool: manager });

    const stream1Events: StreamEvent[] = [];
    for await (const ev of provider.stream(dummyParams)) {
      stream1Events.push(ev);
    }

    const stream2Events: StreamEvent[] = [];
    for await (const ev of provider.stream(dummyParams)) {
      stream2Events.push(ev);
    }

    expect(createdKeys).toEqual(["key-1", "key-2"]);
    expect(stream1Events).toEqual([{ type: "text_delta", text: "from-key-1" }]);
    expect(stream2Events).toEqual([{ type: "text_delta", text: "from-key-2" }]);
  });

  it("handles rate-limit on key-1, cools it, and transparently succeeds with key-2", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("test-provider", ["key-1", "key-2"]);

    let key1Attempts = 0;
    let key2Attempts = 0;

    const factory = (key: string): LLMProvider => ({
      name: "test-provider",
      stream: vi.fn(async function* () {
        if (key === "key-1") {
          key1Attempts++;
          const err: any = new Error("429 Too Many Requests");
          err.status = 429;
          err.headers = { "retry-after": "5" };
          throw err;
        }
        key2Attempts++;
        yield { type: "text_delta" as const, text: "success-from-key-2" };
      }),
    });

    const provider = new KeyPoolProvider("test-provider", factory, { keyPool: manager });

    const events: StreamEvent[] = [];
    for await (const ev of provider.stream(dummyParams)) {
      events.push(ev);
    }

    expect(key1Attempts).toBe(1);
    expect(key2Attempts).toBe(1);
    expect(events).toEqual([{ type: "text_delta", text: "success-from-key-2" }]);

    // Verify key-1 is cooling
    const status = manager.getPoolStatus("test-provider")["test-provider"];
    expect(status.keys[0].isCooling).toBe(true);
    expect(status.keys[1].isCooling).toBe(false);
  });

  it("rotates to next key when key fails with invalid key / auth error", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("test-provider", ["bad-key", "good-key"]);

    const factory = (key: string): LLMProvider => ({
      name: "test-provider",
      stream: vi.fn(async function* () {
        if (key === "bad-key") {
          const err: any = new Error("Invalid API key provided");
          err.status = 401;
          throw err;
        }
        yield { type: "text_delta" as const, text: "recovered-with-good-key" };
      }),
    });

    const provider = new KeyPoolProvider("test-provider", factory, { keyPool: manager });
    const events: StreamEvent[] = [];
    for await (const ev of provider.stream(dummyParams)) {
      events.push(ev);
    }

    expect(events).toEqual([{ type: "text_delta", text: "recovered-with-good-key" }]);
  });

  it("throws immediately on non-retryable 400 Bad Request error without rotating keys", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("test-provider", ["key-1", "key-2"]);

    let calls = 0;
    const factory = (key: string): LLMProvider => ({
      name: "test-provider",
      stream: vi.fn(async function* () {
        calls++;
        const err: any = new Error("Invalid request parameter");
        err.status = 400;
        throw err;
      }),
    });

    const provider = new KeyPoolProvider("test-provider", factory, { keyPool: manager });

    await expect(async () => {
      for await (const _ of provider.stream(dummyParams)) {
        // drain
      }
    }).rejects.toThrow("Invalid request parameter");

    // Only attempted key-1, did not attempt key-2
    expect(calls).toBe(1);
  });

  it("throws AllKeysCoolingError when all registered keys are cooling down", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("test-provider", ["key-1"]);
    manager.reportFailure("test-provider", "key-1", new Error("429"), 10000);

    const factory = vi.fn();
    const provider = new KeyPoolProvider("test-provider", factory, { keyPool: manager });

    await expect(async () => {
      for await (const _ of provider.stream(dummyParams)) {
        // drain
      }
    }).rejects.toThrow(AllKeysCoolingError);
  });

  it("extracts retry-after properly from headers and regex", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError(new Error("resource_exhausted: quota reached"))).toBe(true);
    expect(isRateLimitError(new Error("Generic error"))).toBe(false);

    expect(extractRetryAfterMs({ headers: { "retry-after": "10" } })).toBe(10000);
    expect(extractRetryAfterMs(new Error("Please retry after 4s"))).toBe(4000);
    expect(extractRetryAfterMs(new Error("Rate limit reset in 15 seconds"))).toBe(15000);
    expect(extractRetryAfterMs(new Error("Unknown error"))).toBeUndefined();

    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError(new Error("Invalid API key"))).toBe(true);
    expect(isAuthError({ status: 429 })).toBe(false);
  });

  it("releases key reservation when stream is aborted", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("test-provider", ["key-1"]);

    const controller = new AbortController();
    const factory = (): LLMProvider => ({
      name: "test-provider",
      stream: vi.fn(async function* () {
        controller.abort();
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      }),
    });

    const provider = new KeyPoolProvider("test-provider", factory, { keyPool: manager });

    await expect(async () => {
      for await (const _ of provider.stream({ ...dummyParams, signal: controller.signal })) {
        // drain
      }
    }).rejects.toThrow("aborted");

    const status = manager.getPoolStatus("test-provider")["test-provider"];
    expect(status.activeRequests).toBe(0);
  });
});
