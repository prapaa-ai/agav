import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/fs.js", () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

import { KeyPoolManager } from "../providers/key-pool.js";
import { KeyPoolProvider } from "../providers/key-pool-provider.js";
import { createProvider } from "../providers/registry.js";
import { RetryProvider } from "../providers/retry.js";
import { loadConfig, resolveApiKeys, saveConfig, type AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import * as fsPromises from "node:fs/promises";

function createMockProvider(name: string, streamFn: (params: StreamParams) => AsyncIterable<StreamEvent>, getContextWindowFn?: (model: string) => Promise<number | undefined>): LLMProvider {
  const p: LLMProvider = {
    name,
    stream: streamFn,
  };
  if (getContextWindowFn) {
    p.getContextWindow = getContextWindowFn;
  }
  return p;
}

describe("KeyPoolManager", () => {
  beforeEach(() => {
    KeyPoolManager.resetInstance();
  });

  afterEach(() => {
    KeyPoolManager.resetInstance();
  });

  it("registers keys and initializes slot state", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("anthropic", ["key-1", "key-2", "key-3"]);

    expect(manager.hasKeys("anthropic")).toBe(true);
    expect(manager.hasKeys("openai")).toBe(false);

    const slots = manager.getKeys("anthropic");
    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({
      key: "key-1",
      index: 0,
      coolingUntil: 0,
      activeRequests: 0,
      totalRequests: 0,
      errorCount: 0,
    });
    expect(slots[1].index).toBe(1);
    expect(slots[2].index).toBe(2);
  });

  it("deduplicates keys and trims whitespace", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("openai", ["  key-1  ", "key-2", "key-1", ""]);

    const slots = manager.getKeys("openai");
    expect(slots).toHaveLength(2);
    expect(slots[0].key).toBe("key-1");
    expect(slots[1].key).toBe("key-2");
  });

  it("rotates keys in atomic round-robin order", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("anthropic", ["k1", "k2", "k3"]);

    const first = manager.acquireKey("anthropic");
    const second = manager.acquireKey("anthropic");
    const third = manager.acquireKey("anthropic");
    const fourth = manager.acquireKey("anthropic");

    expect(first.key).toBe("k1");
    expect(first.index).toBe(0);
    expect(second.key).toBe("k2");
    expect(second.index).toBe(1);
    expect(third.key).toBe("k3");
    expect(third.index).toBe(2);
    expect(fourth.key).toBe("k1");
    expect(fourth.index).toBe(0);

    const slots = manager.getKeys("anthropic");
    expect(slots[0].totalRequests).toBe(2);
    expect(slots[0].activeRequests).toBe(2);
    expect(slots[1].totalRequests).toBe(1);
    expect(slots[2].totalRequests).toBe(1);
  });

  it("tracks success and error reporting", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("gemini", ["g1"]);

    const { key, slot } = manager.acquireKey("gemini");
    expect(slot.activeRequests).toBe(1);
    expect(slot.totalRequests).toBe(1);

    manager.reportSuccess("gemini", key);
    expect(slot.activeRequests).toBe(0);
    expect(slot.errorCount).toBe(0);

    manager.acquireKey("gemini");
    expect(slot.activeRequests).toBe(1);

    manager.reportError("gemini", key, new Error("network error"));
    expect(slot.activeRequests).toBe(0);
    expect(slot.errorCount).toBe(1);
  });

  it("reports rate limit and puts key on cooldown while other keys remain available", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("deepseek", ["d1", "d2", "d3"]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Report rate limit on d1 with 60s cooldown
    const start = Date.now();
    manager.reportRateLimit("deepseek", "d1", 60000);

    const slots = manager.getKeys("deepseek");
    expect(slots[0].coolingUntil).toBeGreaterThanOrEqual(start + 59000);
    expect(slots[0].errorCount).toBe(1);

    // Verify warning logged without exposing plaintext key
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("deepseek key #1 cooling down for 60s"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("d1"));

    // Next acquire should skip d1 and return d2, then d3, then d2 again
    const acq1 = manager.acquireKey("deepseek");
    expect(acq1.key).toBe("d2");

    const acq2 = manager.acquireKey("deepseek");
    expect(acq2.key).toBe("d3");

    const acq3 = manager.acquireKey("deepseek");
    expect(acq3.key).toBe("d2");

    warnSpy.mockRestore();
  });

  it("picks the key that becomes available soonest when all keys are in cooldown", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("nvidia", ["n1", "n2"]);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    // n1 cooling for 20s, n2 cooling for 5s
    manager.reportRateLimit("nvidia", "n1", 20000);
    manager.reportRateLimit("nvidia", "n2", 5000);

    expect(manager.hasHealthyKey("nvidia")).toBe(false);

    // Since n2 becomes available sooner (5s vs 20s), it should pick n2
    const acq = manager.acquireKey("nvidia");
    expect(acq.key).toBe("n2");
    expect(acq.index).toBe(1);
  });

  it("throws when acquiring keys for an unregistered provider", () => {
    const manager = KeyPoolManager.getInstance();
    expect(() => manager.acquireKey("nonexistent")).toThrow(/No keys registered for provider "nonexistent"/);
  });
});

describe("KeyPoolProvider", () => {
  beforeEach(() => {
    KeyPoolManager.resetInstance();
  });

  afterEach(() => {
    KeyPoolManager.resetInstance();
  });

  const dummyParams: StreamParams = {
    model: "claude-3-7-sonnet",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };

  it("streams normally with healthy key", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("anthropic", ["key-ok"]);

    const provider = new KeyPoolProvider("anthropic", (apiKey) =>
      createMockProvider("anthropic", async function* () {
        yield { type: "message_start" };
        yield { type: "text_delta", text: `hello with ${apiKey}` };
        yield { type: "message_end", stopReason: "end_turn" };
      }),
    );

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(dummyParams)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "message_start" },
      { type: "text_delta", text: "hello with key-ok" },
      { type: "message_end", stopReason: "end_turn" },
    ]);

    const slots = manager.getKeys("anthropic");
    expect(slots[0].activeRequests).toBe(0);
    expect(slots[0].totalRequests).toBe(1);
    expect(slots[0].errorCount).toBe(0);
  });

  it("automatically rotates away from a 429 key to a healthy key without sleeping", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("anthropic", ["key-rate-limited", "key-healthy"]);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const attempts: string[] = [];
    const provider = new KeyPoolProvider("anthropic", (apiKey) =>
      createMockProvider("anthropic", async function* () {
        attempts.push(apiKey);
        if (apiKey === "key-rate-limited") {
          const err: any = new Error("429 Too Many Requests: Rate limit exceeded");
          err.status = 429;
          throw err;
        }
        yield { type: "text_delta", text: "success from healthy key" };
        yield { type: "message_end", stopReason: "stop" };
      }),
    );

    const startTime = Date.now();
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(dummyParams)) {
      events.push(event);
    }
    const duration = Date.now() - startTime;

    // Both keys were attempted in succession
    expect(attempts).toEqual(["key-rate-limited", "key-healthy"]);

    // Key-healthy succeeded
    expect(events.some((e) => e.type === "text_delta" && e.text === "success from healthy key")).toBe(true);

    // Immediate switch with zero sleep delay (< 200ms)
    expect(duration).toBeLessThan(200);

    // key-rate-limited is now cooling down
    const slots = manager.getKeys("anthropic");
    expect(slots[0].coolingUntil).toBeGreaterThan(Date.now());
    expect(slots[0].errorCount).toBe(1);

    // key-healthy reported success
    expect(slots[1].activeRequests).toBe(0);
    expect(slots[1].errorCount).toBe(0);
  });

  it("rotates away from yielded rate limit error event without sleeping", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("openai", ["k1", "k2"]);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const provider = new KeyPoolProvider("openai", (apiKey) =>
      createMockProvider("openai", async function* () {
        if (apiKey === "k1") {
          yield { type: "error", error: new Error("quota exceeded: rate limit 429") };
          return;
        }
        yield { type: "text_delta", text: "recovered via k2" };
      }),
    );

    const startTime = Date.now();
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(dummyParams)) {
      events.push(event);
    }
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(200);
    expect(events.some((e) => e.type === "text_delta" && e.text === "recovered via k2")).toBe(true);
  });

  it("yields backoff retry event only when all keys in the pool are cooling down", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("openrouter", ["k1"]);

    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    const provider = new KeyPoolProvider("openrouter", () =>
      createMockProvider("openrouter", async function* () {
        attempt++;
        if (attempt === 1) {
          const err: any = new Error("Rate limit exceeded");
          err.status = 429;
          // Set very small retry-after for fast test
          err.headers = { "retry-after": "0.05" };
          throw err;
        }
        yield { type: "text_delta", text: "recovered after cooldown" };
      }),
    );

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(dummyParams)) {
      events.push(event);
    }

    // Must yield the backoff retry error event because all keys were cooling down
    expect(events.some((e) => e.type === "error" && e.error.message.includes("cooling down"))).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.text === "recovered after cooldown")).toBe(true);
  });

  it("forwards getContextWindow when implemented by inner provider", async () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("openrouter", ["k1", "k2"]);

    const mockGetContext = vi.fn().mockResolvedValue(128000);
    const provider = new KeyPoolProvider("openrouter", () =>
      createMockProvider("openrouter", async function* () {}, mockGetContext),
    );

    expect(provider.getContextWindow).toBeTypeOf("function");
    const result = await provider.getContextWindow!("model-a");
    expect(result).toBe(128000);
    expect(mockGetContext).toHaveBeenCalledWith("model-a");
  });

  it("leaves getContextWindow undefined when inner provider does not implement it", () => {
    const manager = KeyPoolManager.getInstance();
    manager.registerKeys("anthropic", ["k1", "k2"]);

    const provider = new KeyPoolProvider("anthropic", () =>
      createMockProvider("anthropic", async function* () {}),
    );

    expect(provider.getContextWindow).toBeUndefined();
  });
});

describe("Config multi-key resolution and encryption", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses comma-separated env vars into multi-key array", () => {
    process.env["ANTHROPIC_API_KEY"] = "key-a, key-b , key-c";

    const keys = resolveApiKeys("ANTHROPIC_API_KEY");
    expect(keys).toEqual(["key-a", "key-b", "key-c"]);
  });

  it("parses numbered env vars in ascending order", () => {
    delete process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY_2"] = "num-2";
    process.env["OPENAI_API_KEY_1"] = "num-1";
    process.env["OPENAI_API_KEY_3"] = "num-3";

    const keys = resolveApiKeys("OPENAI_API_KEY");
    expect(keys).toEqual(["num-1", "num-2", "num-3"]);
  });

  it("seamlessly merges env vars and gives them precedence over config sources", () => {
    process.env["DEEPSEEK_API_KEY"] = "single-1, single-2";
    process.env["DEEPSEEK_API_KEY_1"] = "num-1";
    process.env["DEEPSEEK_API_KEY_2"] = "num-2";

    const keys = resolveApiKeys("DEEPSEEK_API_KEY", [
      { multiple: ["config-key-1", "single-1"] },
    ]);

    // Environment keys strictly take precedence over config sources
    expect(keys).toEqual(["single-1", "single-2", "num-1", "num-2"]);

    // When environment keys are absent, configured tier keys are resolved in order
    delete process.env["DEEPSEEK_API_KEY"];
    delete process.env["DEEPSEEK_API_KEY_1"];
    delete process.env["DEEPSEEK_API_KEY_2"];

    const fallbackKeys = resolveApiKeys("DEEPSEEK_API_KEY", [
      { multiple: ["config-key-1", "config-key-2"] },
    ]);
    expect(fallbackKeys).toEqual(["config-key-1", "config-key-2"]);
  });

  it("encrypts each key in multi-key arrays in saveConfig", async () => {
    const writeFile = vi.mocked(fsPromises.writeFile);
    writeFile.mockClear();

    const config: AgavConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      effort: "high",
      maxTokens: 4096,
      maxIterations: 10,
      errorRetries: 3,
      permissionMode: "ask",
      anthropicApiKey: "secret-main",
      anthropicApiKeys: ["secret-1", "secret-2", "secret-3"],
    };

    await saveConfig(config);

    expect(writeFile).toHaveBeenCalled();
    const savedJsonStr = writeFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(savedJsonStr);

    expect(parsed.anthropicApiKey).toMatch(/^enc:/);
    expect(parsed.anthropicApiKeys).toHaveLength(3);
    for (const key of parsed.anthropicApiKeys) {
      expect(key).toMatch(/^enc:/);
      expect(key).not.toBe("secret-1");
    }
  });
});

describe("Registry integration with KeyPoolProvider", () => {
  beforeEach(() => {
    KeyPoolManager.resetInstance();
  });

  afterEach(() => {
    KeyPoolManager.resetInstance();
  });

  const baseConfig: AgavConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    effort: "high",
    maxTokens: 1024,
    maxIterations: 10,
    errorRetries: 3,
    permissionMode: "ask",
  };

  it("wraps provider in KeyPoolProvider when multiple keys are configured", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "anthropic",
      anthropicApiKeys: ["key-1", "key-2", "key-3"],
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    expect(provider.name).toBe("anthropic");

    // Check inner provider is KeyPoolProvider
    const inner = (provider as any).inner;
    expect(inner).toBeInstanceOf(KeyPoolProvider);

    // Verify keys registered in KeyPoolManager
    const slots = KeyPoolManager.getInstance().getKeys("anthropic");
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.key)).toEqual(["key-1", "key-2", "key-3"]);
  });

  it("uses single provider directly when only one key is present", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "anthropic",
      anthropicApiKey: "single-key",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    const inner = (provider as any).inner;
    expect(inner).not.toBeInstanceOf(KeyPoolProvider);

    const slots = KeyPoolManager.getInstance().getKeys("anthropic");
    expect(slots).toHaveLength(1);
    expect(slots[0].key).toBe("single-key");
  });
});
