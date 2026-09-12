import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";

let capturedClientOptions: any = null;

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      constructor(options: any) {
        capturedClientOptions = options;
      }
      chat = { completions: { create: vi.fn() } };
      responses = { create: vi.fn() };
    },
  };
});

const { createProvider } = await import("../providers/registry.js");

const baseConfig: AgavConfig = {
  provider: "openai",
  model: "gpt-5.4-mini",
  effort: "medium",
  maxTokens: 1024,
  maxIterations: 10,
  errorRetries: 0,
  permissionMode: "ask",
};

beforeEach(() => {
  capturedClientOptions = null;
});

describe("createProvider OpenAI base URL and header passthrough", () => {
  it("forwards openaiBaseURL and openaiHeaders to the OpenAI client", () => {
    createProvider({
      ...baseConfig,
      openaiApiKey: "sk-test",
      openaiBaseURL: "https://my-gateway.example.com/v1",
      openaiHeaders: { "x-api-key": "gateway-token", "x-tenant": "team-a" },
    });

    expect(capturedClientOptions).toEqual({
      apiKey: "sk-test",
      baseURL: "https://my-gateway.example.com/v1",
      defaultHeaders: { "x-api-key": "gateway-token", "x-tenant": "team-a" },
    });
  });

  it("leaves baseURL and headers undefined when not configured", () => {
    createProvider({
      ...baseConfig,
      openaiApiKey: "sk-test",
    });

    expect(capturedClientOptions).toEqual({
      apiKey: "sk-test",
      baseURL: undefined,
      defaultHeaders: undefined,
    });
  });
});
