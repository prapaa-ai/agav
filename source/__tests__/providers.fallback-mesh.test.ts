import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEP_MODELS,
  DEFAULT_FALLBACK_ORDER,
  detectModelTier,
  FallbackMeshProvider,
  FAST_MODELS,
  getFallbackModel,
  isRecoverableProviderError,
} from "../providers/fallback-mesh.js";
import { AllKeysCoolingError } from "../providers/key-pool-provider.js";
import { KeyPoolManager } from "../providers/key-pool.js";
import { createProvider } from "../providers/registry.js";
import { RetryProvider } from "../providers/retry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";

function createMockProvider(
  name: string,
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  return {
    name,
    stream: vi.fn(async function* () {
      yield { type: "text_delta" as const, text: `output from ${name}` };
    }),
    ...overrides,
  };
}

describe("FallbackMeshProvider - Model Tier Mapping and Fallback Ordering", () => {
  it("defines fast and deep models for all 9 supported providers", () => {
    const requiredProviders = [
      "anthropic",
      "openai",
      "openrouter",
      "nvidia",
      "deepseek",
      "gemini",
      "vertex-ai",
      "groq",
      "ollama",
    ];

    for (const p of requiredProviders) {
      expect(FAST_MODELS[p]).toBeDefined();
      expect(typeof FAST_MODELS[p]).toBe("string");
      expect(DEEP_MODELS[p]).toBeDefined();
      expect(typeof DEEP_MODELS[p]).toBe("string");
    }
  });

  it("detects model tiers correctly from model names", () => {
    expect(detectModelTier("claude-3-5-haiku-20241022")).toBe("fast");
    expect(detectModelTier("gpt-4o-mini")).toBe("fast");
    expect(detectModelTier("gemini-2.5-flash")).toBe("fast");
    expect(detectModelTier("gemini-3.5-flash-lite")).toBe("fast");
    expect(detectModelTier("llama-3.1-8b-instruct")).toBe("fast");

    expect(detectModelTier("claude-sonnet-4-20250514")).toBe("deep");
    expect(detectModelTier("gpt-4o")).toBe("deep");
    expect(detectModelTier("deepseek-reasoner")).toBe("deep");
    expect(detectModelTier("gemini-2.5-pro")).toBe("deep");
  });

  it("maps models to target provider preserving tier", () => {
    // Fast models
    expect(getFallbackModel("openai", "claude-3-5-haiku-20241022")).toBe(FAST_MODELS.openai);
    expect(getFallbackModel("gemini", "gpt-4o-mini")).toBe(FAST_MODELS.gemini);

    // Deep models
    expect(getFallbackModel("openai", "claude-sonnet-4-20250514")).toBe(DEEP_MODELS.openai);
    expect(getFallbackModel("deepseek", "gpt-4o")).toBe(DEEP_MODELS.deepseek);
    expect(getFallbackModel("anthropic", "gemini-2.5-pro")).toBe(DEEP_MODELS.anthropic);
  });

  it("has a valid DEFAULT_FALLBACK_ORDER containing core providers", () => {
    expect(DEFAULT_FALLBACK_ORDER[0]).toBe("anthropic");
    expect(DEFAULT_FALLBACK_ORDER).toContain("openai");
    expect(DEFAULT_FALLBACK_ORDER).toContain("gemini");
    expect(DEFAULT_FALLBACK_ORDER).toContain("deepseek");
  });
});

describe("FallbackMeshProvider - Error Classification", () => {
  it("classifies 429 rate limit and quota errors as recoverable", () => {
    expect(isRecoverableProviderError({ status: 429 })).toBe(true);
    expect(isRecoverableProviderError(new Error("Rate limit exceeded"))).toBe(true);
    expect(isRecoverableProviderError(new Error("quota exceeded"))).toBe(true);
    expect(isRecoverableProviderError(new Error("resource_exhausted"))).toBe(true);
  });

  it("classifies 5xx server errors and outages as recoverable", () => {
    expect(isRecoverableProviderError({ status: 500 })).toBe(true);
    expect(isRecoverableProviderError({ status: 502 })).toBe(true);
    expect(isRecoverableProviderError({ status: 503 })).toBe(true);
    expect(isRecoverableProviderError({ status: 529 })).toBe(true);
    expect(isRecoverableProviderError(new Error("Bad Gateway 502"))).toBe(true);
    expect(isRecoverableProviderError(new Error("Service Unavailable"))).toBe(true);
  });

  it("classifies network errors and timeouts as recoverable", () => {
    expect(isRecoverableProviderError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRecoverableProviderError(new Error("Connection timeout"))).toBe(true);
    expect(isRecoverableProviderError(new Error("fetch failed"))).toBe(true);
    expect(isRecoverableProviderError(new Error("ECONNRESET"))).toBe(true);
  });

  it("classifies 404, 400, and auth errors as recoverable ONLY if an alternative provider exists", () => {
    // 404 Model Not Found
    expect(isRecoverableProviderError({ status: 404 }, true)).toBe(true);
    expect(isRecoverableProviderError({ status: 404 }, false)).toBe(false);

    // 400 Bad Request
    expect(isRecoverableProviderError({ status: 400 }, true)).toBe(true);
    expect(isRecoverableProviderError({ status: 400 }, false)).toBe(false);

    // 401 Unauthorized / Invalid API Key
    expect(isRecoverableProviderError({ status: 401 }, true)).toBe(true);
    expect(isRecoverableProviderError({ status: 401 }, false)).toBe(false);
    expect(isRecoverableProviderError(new Error("Invalid API key"), true)).toBe(true);
    expect(isRecoverableProviderError(new Error("Invalid API key"), false)).toBe(false);

    // AllKeysCoolingError
    const coolingErr = new AllKeysCoolingError("anthropic");
    expect(isRecoverableProviderError(coolingErr, true)).toBe(true);
    expect(isRecoverableProviderError(coolingErr, false)).toBe(false);
  });

  it("classifies abort / cancellation as non-recoverable", () => {
    const abortErr = new Error("Aborted");
    abortErr.name = "AbortError";
    expect(isRecoverableProviderError(abortErr, true)).toBe(false);
  });
});

describe("FallbackMeshProvider - Execution and Cascade", () => {
  const dummyParams: StreamParams = {
    model: "claude-3-5-haiku-20241022",
    messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
  };

  it("preserves successful responses without unnecessary fallback", async () => {
    const primary = createMockProvider("anthropic", {
      stream: vi.fn(async function* () {
        yield { type: "message_start" as const };
        yield { type: "text_delta" as const, text: "Success from Anthropic" };
      }),
    });

    const secondary = createMockProvider("openai");

    const mesh = new FallbackMeshProvider({
      primaryProvider: "anthropic",
      providers: { anthropic: primary, openai: secondary },
    });

    const events: StreamEvent[] = [];
    for await (const ev of mesh.stream(dummyParams)) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: "message_start" },
      { type: "text_delta", text: "Success from Anthropic" },
    ]);
    expect(primary.stream).toHaveBeenCalledTimes(1);
    expect(secondary.stream).not.toHaveBeenCalled();
  });

  it("falls back from primary to secondary provider when primary encounters 503", async () => {
    const primary = createMockProvider("anthropic", {
      stream: vi.fn(async function* () {
        const err: any = new Error("Anthropic is down");
        err.status = 503;
        throw err;
      }),
    });

    const secondary = createMockProvider("openai", {
      stream: vi.fn(async function* (params: StreamParams) {
        expect(params.model).toBe(FAST_MODELS.openai); // Model mapped to fast tier!
        yield { type: "text_delta" as const, text: "Recovered via OpenAI" };
      }),
    });

    const onFallback = vi.fn();
    const mesh = new FallbackMeshProvider({
      primaryProvider: "anthropic",
      providers: { anthropic: primary, openai: secondary },
      onFallback,
    });

    const events: StreamEvent[] = [];
    for await (const ev of mesh.stream(dummyParams)) {
      events.push(ev);
    }

    expect(onFallback).toHaveBeenCalledWith("anthropic", "openai", expect.any(Error));
    expect(events.some((e) => e.type === "error" && e.error.message.includes("Falling back to \"openai\""))).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.text === "Recovered via OpenAI")).toBe(true);
  });

  it("cascades across multiple providers in priority order when failures continue", async () => {
    const p1 = createMockProvider("anthropic", {
      stream: vi.fn(async function* () {
        const err: any = new Error("Anthropic 429");
        err.status = 429;
        throw err;
      }),
    });

    const p2 = createMockProvider("openai", {
      stream: vi.fn(async function* () {
        const err: any = new Error("OpenAI 500");
        err.status = 500;
        throw err;
      }),
    });

    const p3 = createMockProvider("gemini", {
      stream: vi.fn(async function* () {
        yield { type: "text_delta" as const, text: "Success from Gemini" };
      }),
    });

    const mesh = new FallbackMeshProvider({
      primaryProvider: "anthropic",
      providers: { anthropic: p1, openai: p2, gemini: p3 },
      fallbackOrder: ["anthropic", "openai", "gemini"],
    });

    const events: StreamEvent[] = [];
    for await (const ev of mesh.stream(dummyParams)) {
      events.push(ev);
    }

    expect(events.some((e) => e.type === "text_delta" && e.text === "Success from Gemini")).toBe(true);
    expect(p1.stream).toHaveBeenCalledTimes(1);
    expect(p2.stream).toHaveBeenCalledTimes(1);
    expect(p3.stream).toHaveBeenCalledTimes(1);
  });

  it("respects maxFallbacks and prevents infinite retry loops", async () => {
    const p1 = createMockProvider("anthropic", {
      stream: vi.fn(async function* () {
        const err: any = new Error("Fail 1");
        err.status = 503;
        throw err;
      }),
    });

    const p2 = createMockProvider("openai", {
      stream: vi.fn(async function* () {
        const err: any = new Error("Fail 2");
        err.status = 503;
        throw err;
      }),
    });

    const p3 = createMockProvider("gemini", {
      stream: vi.fn(async function* () {
        yield { type: "text_delta" as const, text: "Should not be reached" };
      }),
    });

    // maxFallbacks = 1: primary (anthropic) -> 1 fallback (openai) -> abort/throw!
    const mesh = new FallbackMeshProvider({
      primaryProvider: "anthropic",
      providers: { anthropic: p1, openai: p2, gemini: p3 },
      fallbackOrder: ["anthropic", "openai", "gemini"],
      maxFallbacks: 1,
    });

    await expect(async () => {
      for await (const _ of mesh.stream(dummyParams)) {
        // drain
      }
    }).rejects.toThrow("Fail 2");

    expect(p1.stream).toHaveBeenCalledTimes(1);
    expect(p2.stream).toHaveBeenCalledTimes(1);
    expect(p3.stream).not.toHaveBeenCalled();
  });

  it("forwards getContextWindow from primary provider", async () => {
    const primary = createMockProvider("anthropic", {
      getContextWindow: vi.fn().mockResolvedValue(200000),
    });

    const mesh = new FallbackMeshProvider({
      primaryProvider: "anthropic",
      providers: { anthropic: primary },
    });

    expect(mesh.name).toBe("anthropic");
    const window = await mesh.getContextWindow("claude-sonnet-4-20250514");
    expect(window).toBe(200000);
    expect(primary.getContextWindow).toHaveBeenCalledWith("claude-sonnet-4-20250514");
  });
});

describe("createProvider with FallbackMesh and Multi-Key Integration", () => {
  beforeEach(() => {
    KeyPoolManager.resetInstance();
  });

  const baseConfig: AgavConfig = {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    effort: "high",
    maxTokens: 4096,
    maxIterations: 10,
    errorRetries: 3,
    permissionMode: "ask",
  };

  it("returns RetryProvider for standard single-key config (backward compatible)", () => {
    const config: AgavConfig = {
      ...baseConfig,
      anthropicApiKey: "sk-ant-test1234",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    expect(provider.name).toBe("anthropic");

    // Keys registered in KeyPoolManager
    const poolManager = KeyPoolManager.getInstance();
    const status = poolManager.getPoolStatus("anthropic")["anthropic"];
    expect(status.totalKeys).toBe(1);
  });

  it("wraps with FallbackMeshProvider when multiple keys are provided", () => {
    const config: AgavConfig = {
      ...baseConfig,
      anthropicApiKey: "sk-ant-key1,sk-ant-key2",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(FallbackMeshProvider);
    expect(provider.name).toBe("anthropic");

    const poolManager = KeyPoolManager.getInstance();
    const status = poolManager.getPoolStatus("anthropic")["anthropic"];
    expect(status.totalKeys).toBe(2);
  });

  it("wraps with FallbackMeshProvider when fallbackMesh is enabled", () => {
    const config: AgavConfig = {
      ...baseConfig,
      anthropicApiKey: "sk-ant-single",
      openaiApiKey: "sk-openai-backup",
      fallbackMesh: true,
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(FallbackMeshProvider);
    expect(provider.name).toBe("anthropic");
  });
});
