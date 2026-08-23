import { describe, expect, it } from "vitest";
import { createProvider } from "../providers/registry.js";
import { OpenRouterProvider } from "../providers/openrouter.js";
import { OpenAIProvider } from "../providers/openai.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { GeminiProvider } from "../providers/gemini.js";
import { OllamaProvider } from "../providers/ollama.js";
import { VertexAIProvider } from "../providers/vertex-ai.js";
import { RetryProvider } from "../providers/retry.js";
import type { AgavConfig } from "../config/config.js";

const baseConfig: AgavConfig = {
  provider: "openrouter",
  model: "openrouter/auto",
  effort: "high",
  maxTokens: 1024,
  maxIterations: 10,
  errorRetries: 3,
  permissionMode: "ask",
};

describe("createProvider registry", () => {
  it("creates OpenRouterProvider wrapped in RetryProvider for openrouter", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "openrouter",
      openrouterApiKey: "sk-or-v1-test",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    expect(provider.name).toBe("openrouter");
    expect(provider.getContextWindow).toBeTypeOf("function");
  });

  it("throws when OpenRouter credentials are missing", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "openrouter",
      openrouterApiKey: undefined,
    };

    expect(() => createProvider(config)).toThrow(/OpenRouter API key not found/);
  });

  it("creates OpenAIProvider for openai", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "openai",
      openaiApiKey: "sk-test",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    expect(provider.name).toBe("openai");
  });

  it("creates AnthropicProvider for anthropic", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    expect(provider.name).toBe("anthropic");
  });

  it("creates GeminiProvider for gemini", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "gemini",
      geminiApiKey: "gemini-test",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    expect(provider.name).toBe("gemini");
  });

  it("creates OllamaProvider for ollama", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "ollama",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    expect(provider.name).toBe("ollama");
  });

  it("creates VertexAIProvider for vertex-ai", () => {
    const config: AgavConfig = {
      ...baseConfig,
      provider: "vertex-ai",
      vertexAICredentialsPath: "/tmp/fake-sa.json",
    };

    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(RetryProvider);
    expect(provider.name).toBe("vertex-ai");
  });

  it("throws on unsupported provider", () => {
    const config: any = {
      ...baseConfig,
      provider: "unsupported-provider",
    };

    expect(() => createProvider(config)).toThrow();
  });
});
