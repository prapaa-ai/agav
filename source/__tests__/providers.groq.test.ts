import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GroqProvider, GROQ_BASE_URL } from "../providers/groq.js";
import { createProvider, createBaseProvider } from "../providers/registry.js";
import { fastCommand, deepCommand } from "../commands/model-routing.js";
import { KeyPoolManager } from "../providers/key-pool.js";
import type { AgavConfig } from "../config/config.js";
import type { CommandContext } from "../commands/types.js";

describe("providers/groq", () => {
  let sampleGroqKey: string;

  beforeEach(() => {
    KeyPoolManager.resetInstance();
    sampleGroqKey = ["gsk", "test", "groq", "key12345"].join("_");
  });

  afterEach(() => {
    KeyPoolManager.resetInstance();
    vi.restoreAllMocks();
  });

  it("instantiates with proper provider name and base URL", () => {
    const provider = new GroqProvider(sampleGroqKey);
    expect(provider.name).toBe("groq");
    expect(GROQ_BASE_URL).toBe("https://api.groq.com/openai/v1");
  });

  it("reports correct context windows for supported Groq models", async () => {
    const provider = new GroqProvider(sampleGroqKey);

    expect(await provider.getContextWindow("llama-3.3-70b-versatile")).toBe(131072);
    expect(await provider.getContextWindow("llama-3.1-8b-instant")).toBe(131072);
    expect(await provider.getContextWindow("mixtral-8x7b-32768")).toBe(32768);
    expect(await provider.getContextWindow("unknown-groq-model")).toBe(131072);
  });

  it("instantiates via createBaseProvider", () => {
    const config: AgavConfig = {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      groqApiKey: sampleGroqKey,
      effort: "medium",
      maxTokens: 4096,
      maxIterations: 20,
      errorRetries: 2,
      permissionMode: "ask",
    };

    const base = createBaseProvider("groq", sampleGroqKey, config);
    expect(base).toBeInstanceOf(GroqProvider);
    expect(base.name).toBe("groq");
  });

  it("instantiates via createProvider with single key and key pool integration", () => {
    const config: AgavConfig = {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      groqApiKey: sampleGroqKey,
      effort: "medium",
      maxTokens: 4096,
      maxIterations: 20,
      errorRetries: 2,
      permissionMode: "ask",
    };

    const provider = createProvider(config);
    expect(provider).toBeDefined();

    // Verify key pool registered the groq key
    const status = KeyPoolManager.getInstance().getPoolStatus("groq");
    expect(status.groq?.totalKeys).toBe(1);
  });

  it("supports multiple groq keys in KeyPoolProvider", () => {
    const key2 = ["gsk", "test", "groq", "key67890"].join("_");
    const config: AgavConfig = {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      groqApiKeys: [sampleGroqKey, key2],
      effort: "medium",
      maxTokens: 4096,
      maxIterations: 20,
      errorRetries: 2,
      permissionMode: "ask",
    };

    const provider = createProvider(config);
    expect(provider).toBeDefined();

    const status = KeyPoolManager.getInstance().getPoolStatus("groq");
    expect(status.groq?.totalKeys).toBe(2);
  });

  it("routes /fast and /deep commands to Groq models correctly", async () => {
    let activeModel = "";
    const mockContext = {
      config: {
        provider: "groq",
        model: "llama-3.3-70b-versatile",
      } as AgavConfig,
      setModel: (m: string) => {
        activeModel = m;
      },
    } as CommandContext;

    const fastRes = await fastCommand.execute("", mockContext);
    expect(fastRes.type).toBe("message");
    expect(activeModel).toBe("llama-3.1-8b-instant");

    const deepRes = await deepCommand.execute("", mockContext);
    expect(deepRes.type).toBe("message");
    expect(activeModel).toBe("llama-3.3-70b-versatile");
  });
});
