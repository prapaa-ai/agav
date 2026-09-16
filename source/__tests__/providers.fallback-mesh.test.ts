import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyPoolManager } from "../providers/key-pool.js";
import {
  FallbackMeshProvider,
  mapModelForProvider,
  getFallbackChain,
  isFastModel,
  isRecoverableProviderError,
} from "../providers/fallback-mesh.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";

const dummyParams: StreamParams = {
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
};

function createMockProvider(
  name: string,
  streamFn: (params: StreamParams) => AsyncIterable<StreamEvent>,
): LLMProvider {
  return {
    name,
    stream: streamFn,
  };
}

describe("FallbackMeshProvider & Model Tier Mapping", () => {
  beforeEach(() => {
    KeyPoolManager.resetInstance();
  });

  describe("Model Tier Mapping", () => {
    it("correctly identifies fast vs deep models", () => {
      expect(isFastModel("gemini-2.5-flash")).toBe(true);
      expect(isFastModel("gemini-3.5-flash-lite")).toBe(true);
      expect(isFastModel("gpt-4o-mini")).toBe(true);
      expect(isFastModel("claude-haiku-4-5-20251001")).toBe(true);
      expect(isFastModel("llama-3.1-8b-instant")).toBe(true);
      expect(isFastModel("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe(true);

      expect(isFastModel("gemini-3.5-pro")).toBe(false);
      expect(isFastModel("gpt-4o")).toBe(false);
      expect(isFastModel("claude-sonnet-4-20250514")).toBe(false);
      expect(isFastModel("meta/llama-3.1-405b-instruct")).toBe(false);
    });

    it("maps fast models across providers", () => {
      expect(mapModelForProvider("gemini-2.5-flash", "gemini", "nvidia")).toBe(
        "nvidia/nemotron-3.5-lightning-30b-a3b",
      );
      expect(mapModelForProvider("gemini-2.5-flash", "gemini", "groq")).toBe(
        "qwen/qwen3.8-27b",
      );
      expect(mapModelForProvider("gemini-2.5-flash", "gemini", "openai")).toBe(
        "gpt-4o-mini",
      );
      expect(mapModelForProvider("gemini-2.5-flash", "gemini", "gemini")).toBe(
        "gemini-2.5-flash",
      );
    });

    it("maps deep models across providers", () => {
      expect(mapModelForProvider("gemini-3.5-pro", "gemini", "groq")).toBe(
        "openai/gpt-oss-120b",
      );
      expect(mapModelForProvider("gemini-3.5-pro", "gemini", "nvidia")).toBe(
        "nvidia/nemotron-3.5-lightning-30b-a3b",
      );
      expect(mapModelForProvider("gemini-3.5-pro", "gemini", "anthropic")).toBe(
        "claude-sonnet-4-20250514",
      );
    });

    describe("Recoverable Provider Error Detection", () => {
      it("recognizes 404 model not found as recoverable", () => {
        const err404 = new Error(
          "404 The model 'llama-3.1-8b-instant' does not exist or you do not have access to it.",
        );
        expect(isRecoverableProviderError(err404)).toBe(true);
      });

      it("recognizes 400 unsupported tool calling as recoverable", () => {
        const err400 = new Error(
          "Failed to call createChatCompletion: `tool calling` is not supported with this model",
        );
        expect(isRecoverableProviderError(err400)).toBe(true);
      });

      it("recognizes Gemini 400 thought_signature missing error as recoverable", () => {
        const err400 = new Error(
          'Gemini API error 400: {"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly...","status":"INVALID_ARGUMENT"}}',
        );
        expect(isRecoverableProviderError(err400)).toBe(true);
      });

      it("recognizes 429 rate limit / quota exhaustion as recoverable", () => {
        const err429 = { status: 429, message: "Rate limit exceeded" };
        expect(isRecoverableProviderError(err429)).toBe(true);
      });

      it("does not treat unrelated user syntax errors as recoverable", () => {
        const syntaxErr = new SyntaxError("Unexpected token in JSON at position 0");
        expect(isRecoverableProviderError(syntaxErr)).toBe(false);
      });
    });
  });

  describe("Fallback Chain Resolution", () => {
    it("constructs priority chain filtering unconfigured providers", () => {
      const config: AgavConfig = {
        provider: "gemini",
        model: "gemini-2.5-flash",
        effort: "medium",
        maxTokens: 1024,
        maxIterations: 10,
        errorRetries: 3,
        permissionMode: "ask",
        geminiApiKey: "AIza-gemini-key",
        nvidiaApiKey: "nvapi-test-key",
        groqApiKey: "gsk_groq_key",
      };

      const chain = getFallbackChain("gemini", config);
      expect(chain[0]).toBe("gemini");
      expect(chain).toContain("nvidia");
      expect(chain).toContain("groq");
      expect(chain).not.toContain("anthropic");
      expect(chain).not.toContain("deepseek");
    });
  });

  describe("Cross-Provider Failover", () => {
    it("automatically cascades from Gemini 429 quota exhaustion to NVIDIA with mapped model", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("gemini", ["gemini-key-1"]);
      keyPool.registerKeys("nvidia", ["nvidia-key-1"]);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const config: AgavConfig = {
        provider: "gemini",
        model: "gemini-2.5-flash",
        effort: "medium",
        maxTokens: 1024,
        maxIterations: 10,
        errorRetries: 3,
        permissionMode: "ask",
        geminiApiKey: "gemini-key-1",
        nvidiaApiKey: "nvidia-key-1",
      };

      const attempts: string[] = [];
      const modelsSeen: string[] = [];

      const mockFactory = (provider: string): LLMProvider | null => {
        if (provider === "gemini") {
          return createMockProvider("gemini", async function* (params) {
            attempts.push("gemini");
            modelsSeen.push(params.model);
            const err: any = new Error(
              "[GoogleGenerativeAI Error]: [429 Too Many Requests] Resource has been exhausted (e.g. check quota).",
            );
            err.status = 429;
            throw err;
          });
        }
        if (provider === "nvidia") {
          return createMockProvider("nvidia", async function* (params) {
            attempts.push("nvidia");
            modelsSeen.push(params.model);
            yield { type: "text_delta", text: "Response generated via NVIDIA NIM" };
            yield { type: "message_end", stopReason: "stop" };
          });
        }
        return null;
      };

      const mesh = new FallbackMeshProvider(config, keyPool, {
        customFactory: mockFactory,
      });

      const events: StreamEvent[] = [];
      for await (const ev of mesh.stream(dummyParams)) {
        events.push(ev);
      }

      // Both providers were called in succession
      expect(attempts).toEqual(["gemini", "nvidia"]);

      // Gemini received original model; NVIDIA received mapped fast model
      expect(modelsSeen[0]).toBe("gemini-2.5-flash");
      expect(modelsSeen[1]).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");

      // Auto-fallback notice emitted to stream
      const textDeltas = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text);
      expect(textDeltas.some((t) => t.includes("[Auto-Fallback]"))).toBe(true);
      expect(textDeltas.some((t) => t.includes("Response generated via NVIDIA NIM"))).toBe(true);

      // Active serving provider updated
      expect(mesh.getActiveServingProvider()).toBe("nvidia");

      // Gemini key marked cooling down in KeyPoolManager
      const geminiSlots = keyPool.getKeys("gemini");
      expect(geminiSlots[0].coolingUntil).toBeGreaterThan(Date.now());
    });

    it("cascades across multiple levels: Gemini -> NVIDIA -> Groq", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("gemini", ["gem-1"]);
      keyPool.registerKeys("nvidia", ["nv-1"]);
      keyPool.registerKeys("groq", ["grq-1"]);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const config: AgavConfig = {
        provider: "gemini",
        model: "gemini-3.5-pro",
        effort: "medium",
        maxTokens: 1024,
        maxIterations: 10,
        errorRetries: 3,
        permissionMode: "ask",
        geminiApiKey: "gem-1",
        nvidiaApiKey: "nv-1",
        groqApiKey: "grq-1",
      };

      const attempts: string[] = [];

      const mockFactory = (provider: string): LLMProvider | null => {
        if (provider === "gemini") {
          return createMockProvider("gemini", async function* () {
            attempts.push("gemini");
            const err: any = new Error("RESOURCE_EXHAUSTED: Rate limit exceeded");
            err.status = 429;
            throw err;
          });
        }
        if (provider === "nvidia") {
          return createMockProvider("nvidia", async function* () {
            attempts.push("nvidia");
            const err: any = new Error("429 Too Many Requests: Rate limit reached");
            err.status = 429;
            throw err;
          });
        }
        if (provider === "groq") {
          return createMockProvider("groq", async function* () {
            attempts.push("groq");
            yield { type: "text_delta", text: "Groq deep model success" };
          });
        }
        return null;
      };

      const mesh = new FallbackMeshProvider(config, keyPool, {
        customFactory: mockFactory,
        customFallbackOrder: ["nvidia", "groq"],
      });

      const events: StreamEvent[] = [];
      for await (const ev of mesh.stream({ ...dummyParams, model: "gemini-3.5-pro" })) {
        events.push(ev);
      }

      expect(attempts).toEqual(["gemini", "nvidia", "groq"]);
      const texts = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text)
        .join("");
      expect(texts).toContain("Groq deep model success");
      expect(mesh.getActiveServingProvider()).toBe("groq");
    });

    it("automatically cascades from HTTP 404 model deprecation error to next healthy provider", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("groq", ["grq-1"]);
      keyPool.registerKeys("nvidia", ["nv-1"]);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const config: AgavConfig = {
        provider: "groq",
        model: "llama-3.1-8b-instant",
        effort: "medium",
        maxTokens: 1024,
        maxIterations: 10,
        errorRetries: 3,
        permissionMode: "ask",
        groqApiKey: "grq-1",
        nvidiaApiKey: "nv-1",
      };

      const attempts: string[] = [];
      const mockFactory = (provider: string): LLMProvider | null => {
        if (provider === "groq") {
          return createMockProvider("groq", async function* () {
            attempts.push("groq");
            const err: any = new Error(
              "404 The model 'llama-3.1-8b-instant' does not exist or you do not have access to it.",
            );
            err.status = 404;
            throw err;
          });
        }
        if (provider === "nvidia") {
          return createMockProvider("nvidia", async function* () {
            attempts.push("nvidia");
            yield { type: "text_delta", text: "Successfully recovered on NVIDIA NIM!" };
          });
        }
        return null;
      };

      const mesh = new FallbackMeshProvider(config, keyPool, {
        customFactory: mockFactory,
        customFallbackOrder: ["nvidia"],
      });

      const events: StreamEvent[] = [];
      for await (const ev of mesh.stream(dummyParams)) {
        events.push(ev);
      }

      expect(attempts).toEqual(["groq", "nvidia"]);
      const texts = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text)
        .join("");
      expect(texts).toContain("Successfully recovered on NVIDIA NIM!");
      expect(mesh.getActiveServingProvider()).toBe("nvidia");
    });

    it("automatically cascades from Gemini HTTP 400 thought_signature error to next healthy provider", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("gemini", ["gem-1"]);
      keyPool.registerKeys("nvidia", ["nv-1"]);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const config: AgavConfig = {
        provider: "gemini",
        model: "gemini-flash-lite-latest",
        effort: "medium",
        maxTokens: 1024,
        maxIterations: 10,
        errorRetries: 3,
        permissionMode: "ask",
        geminiApiKey: "gem-1",
        nvidiaApiKey: "nv-1",
      };

      const attempts: string[] = [];
      const mockFactory = (provider: string): LLMProvider | null => {
        if (provider === "gemini") {
          return createMockProvider("gemini", async function* () {
            attempts.push("gemini");
            const err = new Error(
              'Gemini API error 400: {"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly...","status":"INVALID_ARGUMENT"}}',
            );
            throw err;
          });
        }
        if (provider === "nvidia") {
          return createMockProvider("nvidia", async function* () {
            attempts.push("nvidia");
            yield { type: "text_delta", text: "Successfully recovered from 400 via NVIDIA NIM!" };
          });
        }
        return null;
      };

      const mesh = new FallbackMeshProvider(config, keyPool, {
        customFactory: mockFactory,
        customFallbackOrder: ["nvidia"],
      });

      const events: StreamEvent[] = [];
      for await (const ev of mesh.stream(dummyParams)) {
        events.push(ev);
      }

      expect(attempts).toEqual(["gemini", "nvidia"]);
      const texts = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text)
        .join("");
      expect(texts).toContain("Successfully recovered from 400 via NVIDIA NIM!");
      expect(mesh.getActiveServingProvider()).toBe("nvidia");
    });

    it("skips cooling primary provider on subsequent turn and routes directly to healthy fallback", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("gemini", ["gem-1"]);
      keyPool.registerKeys("groq", ["grq-1"]);

      // Set gemini on cooldown
      keyPool.reportRateLimit("gemini", "gem-1", 60000);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const config: AgavConfig = {
        provider: "gemini",
        model: "gemini-2.5-flash",
        effort: "medium",
        maxTokens: 1024,
        maxIterations: 10,
        errorRetries: 3,
        permissionMode: "ask",
        geminiApiKey: "gem-1",
        groqApiKey: "grq-1",
      };

      const attempts: string[] = [];
      const mockFactory = (provider: string): LLMProvider | null => {
        return createMockProvider(provider, async function* () {
          attempts.push(provider);
          yield { type: "text_delta", text: `Success from ${provider}` };
        });
      };

      const mesh = new FallbackMeshProvider(config, keyPool, {
        customFactory: mockFactory,
      });

      const events: StreamEvent[] = [];
      for await (const ev of mesh.stream(dummyParams)) {
        events.push(ev);
      }

      // Gemini was never attempted because it is cooling down; Groq took over directly!
      expect(attempts).toEqual(["groq"]);
      expect(events.some((e) => e.type === "text_delta" && (e as any).text.includes("Success from groq"))).toBe(true);
    });

    it("yields clear countdown error when all providers in chain are cooling down", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("gemini", ["gem-1"]);
      keyPool.registerKeys("groq", ["grq-1"]);

      keyPool.reportRateLimit("gemini", "gem-1", 10000);
      keyPool.reportRateLimit("groq", "grq-1", 20000);

      vi.spyOn(console, "warn").mockImplementation(() => {});

      const config: AgavConfig = {
        provider: "gemini",
        model: "gemini-2.5-flash",
        effort: "medium",
        maxTokens: 1024,
        maxIterations: 10,
        errorRetries: 3,
        permissionMode: "ask",
        geminiApiKey: "gem-1",
        groqApiKey: "grq-1",
      };

      const mesh = new FallbackMeshProvider(config, keyPool);
      const events: StreamEvent[] = [];
      for await (const ev of mesh.stream(dummyParams)) {
        events.push(ev);
      }

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect((errorEvent as any).error.message).toMatch(
        /All configured AI providers \(gemini, groq\) are currently cooling down/,
      );
    });
  });
});
