import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { keysCommand, maskApiKey } from "../commands/keys.js";
import { KeyPoolManager } from "../providers/key-pool.js";
import type { CommandContext } from "../commands/types.js";
import * as keysInteractiveModule from "../config/keys-interactive.js";
import { runInteractiveKeysManager } from "../config/keys-interactive.js";
import type * as readline from "node:readline/promises";

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    saveConfig: vi.fn().mockResolvedValue(undefined),
  };
});

function createMockReadline(answers: string[]) {
  let index = 0;
  return {
    question: vi.fn(async (_prompt: string) => {
      const answer = answers[index++] ?? "";
      return answer;
    }),
    close: vi.fn(),
  } as unknown as readline.Interface;
}

describe("/keys slash command and key masking", () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    KeyPoolManager.resetInstance();
    mockContext = {
      config: { provider: "openai" } as any,
    } as CommandContext;
  });

  afterEach(() => {
    KeyPoolManager.resetInstance();
  });

  describe("maskApiKey", () => {
    it("masks short keys without exposing them", () => {
      expect(maskApiKey("short")).toBe("****rt");
      expect(maskApiKey("12345678")).toBe("****78");
    });

    it("masks typical API keys securely preserving prefix and suffix only", () => {
      const anthropicKey = "sk-ant-api03-abcdef1234567890xyz";
      const maskedAnthropic = maskApiKey(anthropicKey);
      expect(maskedAnthropic).toContain("...");
      expect(maskedAnthropic).not.toContain("abcdef1234567890");
      expect(maskedAnthropic.startsWith("sk-ant-")).toBe(true);
      expect(maskedAnthropic.endsWith("0xyz")).toBe(true);

      const openAiKey = "sk-proj-super-secret-key-token-abcd";
      const maskedOpenAI = maskApiKey(openAiKey);
      expect(maskedOpenAI).toContain("...");
      expect(maskedOpenAI).not.toContain("super-secret-key-token");
    });

    it("handles empty key gracefully", () => {
      expect(maskApiKey("")).toBe("(empty)");
    });
  });

  describe("keysCommand execution", () => {
    it("defines command metadata matching requirements", () => {
      expect(keysCommand.name).toBe("keys");
      expect(keysCommand.description).toBe("View and manage the Multi-API-Key pool and rate-limit status");
      expect(keysCommand.usage).toContain("Usage: /keys [provider]");
      expect(keysCommand.usage).toContain("without exposing plaintext secrets");
    });

    it("informs user when no keys are registered", async () => {
      const result = await keysCommand.execute("", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain("No API keys are currently registered in the Multi-API-Key pool");
      }
    });

    it("displays registered keys, healthy status, active requests, and error counts for all providers", async () => {
      const pool = KeyPoolManager.getInstance();
      pool.registerKeys("openai", [
        "sk-test-openai-key-alpha-1234",
        "sk-test-openai-key-beta-5678",
      ]);
      pool.registerKeys("anthropic", [
        "sk-ant-test-key-primary-9999",
      ]);

      const result = await keysCommand.execute("", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain("Multi-API-Key Pool Status:");
        expect(result.text).toContain("Provider: openai (2 keys)");
        expect(result.text).toContain("Provider: anthropic (1 keys)");
        expect(result.text).toContain("[Key #1]");
        expect(result.text).toContain("[Key #2]");
        expect(result.text).toContain("Status: HEALTHY");
        expect(result.text).toContain("Cooldown: 0s");
        expect(result.text).toContain("Active: 0");
        expect(result.text).toContain("Errors: 0");

        // Ensure plaintext secrets are NOT exposed
        expect(result.text).not.toContain("sk-test-openai-key-alpha-1234");
        expect(result.text).not.toContain("sk-test-openai-key-beta-5678");
        expect(result.text).not.toContain("sk-ant-test-key-primary-9999");
      }
    });

    it("filters output when a specific provider is requested", async () => {
      const pool = KeyPoolManager.getInstance();
      pool.registerKeys("openai", ["sk-openai-key-1-abcd", "sk-openai-key-2-efgh"]);
      pool.registerKeys("anthropic", ["sk-ant-key-1-ijkl"]);

      const result = await keysCommand.execute("openai", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain('Multi-API-Key Pool Status for "openai" (2 registered):');
        expect(result.text).not.toContain("anthropic");
      }
    });

    it("displays warning if requested provider has no registered keys", async () => {
      const result = await keysCommand.execute("unknown-provider", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain('No keys registered for provider "unknown-provider"');
      }
    });

    it("correctly indicates cooling status, remaining cooldown time, and error count", async () => {
      const pool = KeyPoolManager.getInstance();
      const testKey = "sk-cooling-test-key-secret-1234";
      pool.registerKeys("gemini", [testKey]);

      // Trigger rate limit with 45s cooldown
      pool.reportRateLimit("gemini", testKey, 45000);

      const result = await keysCommand.execute("gemini", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain("COOLING");
        expect(result.text).toMatch(/Cooldown: \d+s/);
        expect(result.text).toContain("Errors: 1");
      }
    });

    it("adds multiple keys via /keys add and updates config and pool", async () => {
      const result = await keysCommand.execute(
        "add groq gsk_key_alpha_111, gsk_key_beta_222",
        mockContext,
      );

      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain("Successfully encrypted and saved 2 key(s) for 'groq'");
        expect(result.text).toContain("Multi-API-Key Pool Status for 'groq' (2 active keys):");
      }

      // Check config was updated
      expect((mockContext.config as any).groqApiKey).toBe("gsk_key_alpha_111");
      expect((mockContext.config as any).groqApiKeys).toEqual([
        "gsk_key_alpha_111",
        "gsk_key_beta_222",
      ]);

      // Check pool was updated
      const slots = KeyPoolManager.getInstance().getKeys("groq");
      expect(slots.length).toBe(2);
      expect(slots[0].key).toBe("gsk_key_alpha_111");
      expect(slots[1].key).toBe("gsk_key_beta_222");
    });

    it("shows usage error when /keys add is missing arguments", async () => {
      const result = await keysCommand.execute("add", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain("Usage: /keys add <provider> <key1,key2,...>");
      }
    });

    it("clears keys for a provider via /keys clear and resets pool and config", async () => {
      // First populate some keys
      mockContext.config.nvidiaApiKey = "nvapi-test-key-123";
      mockContext.config.nvidiaApiKeys = ["nvapi-test-key-123"];
      KeyPoolManager.getInstance().registerKeys("nvidia", ["nvapi-test-key-123"]);

      const result = await keysCommand.execute("clear nvidia", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain("Cleared all API keys for provider 'nvidia'");
      }

      // Config should have keys deleted
      expect(mockContext.config.nvidiaApiKey).toBeUndefined();
      expect(mockContext.config.nvidiaApiKeys).toBeUndefined();

      // Pool should be empty
      const slots = KeyPoolManager.getInstance().getKeys("nvidia");
      expect(slots.length).toBe(0);
    });

    it("shows usage error when /keys clear is missing provider", async () => {
      const result = await keysCommand.execute("clear", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain("Usage: /keys clear <provider>");
      }
    });
  });

  describe("runInteractiveKeysManager", () => {
    it("adds keys interactively (menu [2] -> provider [1] groq -> enter keys)", async () => {
      const mockRl = createMockReadline(["2", "1", "gsk_test1, gsk_test2"]);
      const result = await runInteractiveKeysManager(mockContext.config, { customRl: mockRl });

      expect(result).toContain("Successfully encrypted and saved 2 key(s) for 'groq'");
      expect(result).toContain("Multi-API-Key Pool Status for 'groq' (2 active keys):");
      expect((mockContext.config as any).groqApiKey).toBe("gsk_test1");
      expect((mockContext.config as any).groqApiKeys).toEqual(["gsk_test1", "gsk_test2"]);

      const slots = KeyPoolManager.getInstance().getKeys("groq");
      expect(slots.length).toBe(2);
      expect(slots[0].key).toBe("gsk_test1");
      expect(slots[1].key).toBe("gsk_test2");
    });

    it("switches to ollama interactively (menu [2] -> provider [8] ollama)", async () => {
      const mockRl = createMockReadline(["2", "8"]);
      const result = await runInteractiveKeysManager(mockContext.config, { customRl: mockRl });

      expect(result).toContain("Switched provider to 'ollama'");
      expect(mockContext.config.provider).toBe("ollama");
    });

    it("removes keys interactively (menu [4] -> provider)", async () => {
      (mockContext.config as any).groqApiKey = "gsk_existing";
      (mockContext.config as any).groqApiKeys = ["gsk_existing"];
      KeyPoolManager.getInstance().registerKeys("groq", ["gsk_existing"]);

      const mockRl = createMockReadline(["4", "1"]);
      const result = await runInteractiveKeysManager(mockContext.config, { customRl: mockRl });

      expect(result).toContain("Cleared all API keys for provider 'groq'");
      expect((mockContext.config as any).groqApiKey).toBeUndefined();
      expect((mockContext.config as any).groqApiKeys).toBeUndefined();
      expect(KeyPoolManager.getInstance().getKeys("groq").length).toBe(0);
    });

    it("views keys interactively (menu [1])", async () => {
      KeyPoolManager.getInstance().registerKeys("openai", ["sk-test-key-1234567890"]);
      const mockRl = createMockReadline(["1"]);
      const result = await runInteractiveKeysManager(mockContext.config, { customRl: mockRl });

      expect(result).toContain("Multi-API-Key Pool Status:");
      expect(result).toContain("Provider: openai (1 keys)");
      expect(result).toContain("HEALTHY");
      expect(result).not.toContain("sk-test-key-1234567890");
    });

    it("exits cleanly (menu [5])", async () => {
      const mockRl = createMockReadline(["5"]);
      const result = await runInteractiveKeysManager(mockContext.config, { customRl: mockRl });

      expect(result).toContain("Exited Multi-API-Key Manager.");
    });
  });

  describe("interactive /keys command invocation", () => {
    it("suspends terminal and calls runInteractiveKeysManager when suspendTerminal is available", async () => {
      const resumeMock = vi.fn();
      mockContext.suspendTerminal = vi.fn().mockReturnValue(resumeMock);
      mockContext.refreshDisplay = vi.fn();

      const spy = vi
        .spyOn(keysInteractiveModule, "runInteractiveKeysManager")
        .mockResolvedValueOnce("Interactive Summary");

      const result = await keysCommand.execute("", mockContext);

      expect(mockContext.suspendTerminal).toHaveBeenCalled();
      expect(resumeMock).toHaveBeenCalled();
      expect(mockContext.refreshDisplay).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(mockContext.config, { isTTY: true });
      expect(result).toEqual({ type: "message", text: "Interactive Summary" });

      spy.mockRestore();
    });
  });
});
