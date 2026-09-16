import { beforeEach, describe, expect, it } from "vitest";
import {
  usageCommand,
  formatNumber,
  renderProgressBar,
  collectUsageData,
} from "../commands/usage.js";
import { KeyPoolManager } from "../providers/key-pool.js";
import { ConversationState } from "../agent/conversation.js";
import type { CommandContext, DebugState } from "../commands/types.js";
import type { AgavConfig } from "../config/config.js";

describe("/usage slash command & telemetry dashboard", () => {
  let mockConfig: AgavConfig;
  let mockConversation: ConversationState;
  let mockDebugState: DebugState;
  let mockContext: CommandContext;

  beforeEach(() => {
    KeyPoolManager.resetInstance();

    mockConfig = {
      provider: "gemini",
      model: "gemini-2.5-flash",
      effort: "medium",
      maxTokens: 1024,
      maxIterations: 10,
      errorRetries: 3,
      permissionMode: "ask",
      geminiApiKey: "AIzaSyTestKey1234567890",
      nvidiaApiKey: "nvapi-test-nvidia-key",
      groqApiKey: "gsk_groq_test_key_abc",
    };

    mockConversation = new ConversationState();
    mockConversation.setModel("gemini-2.5-flash");
    mockConversation.addUserMessage("Can you build a simple server?");
    mockConversation.addAssistantMessage([
      { type: "text", text: "Sure! Here is an Express server." },
    ]);

    mockDebugState = {
      tokenUsage: {
        inputTokens: 14250,
        outputTokens: 3820,
        cacheReadTokens: 12400,
        cacheWriteTokens: 1100,
      },
      loadedPlugins: [],
      mcpServers: [],
      mcpResources: 0,
      mcpPrompts: 0,
    };

    mockContext = {
      config: mockConfig,
      conversation: mockConversation,
      setModel: () => {},
      setProvider: () => {},
      setEffort: () => {},
      clearMessages: () => {},
      refreshPlan: () => {},
      showStatus: () => {},
      saveSession: () => {},
      refreshDisplay: () => {},
      loadSession: () => {},
      activateSession: () => {},
      renameSession: () => {},
      exit: () => {},
      getDebugState: () => mockDebugState,
      submit: () => {},
      handleSubmit: () => {},
      toolRegistry: {} as any,
      addTokenUsage: () => {},
      setRunningSkill: () => {},
      setPickerActive: () => {},
      suspendTerminal: () => () => {},
      showAgentsTUI: () => {},
      showSkillsTUI: () => {},
    };
  });

  describe("Formatting utilities", () => {
    it("formats numbers with comma thousands separators", () => {
      expect(formatNumber(0)).toBe("0");
      expect(formatNumber(1250)).toBe("1,250");
      expect(formatNumber(1000000)).toBe("1,000,000");
    });

    it("renders visual progress bar accurately", () => {
      const emptyBar = renderProgressBar(0, 10);
      expect(emptyBar).toBe("[░░░░░░░░░░] 0.0%");

      const halfBar = renderProgressBar(50, 10);
      expect(halfBar).toBe("[█████░░░░░] 50.0%");

      const fullBar = renderProgressBar(100, 10);
      expect(fullBar).toBe("[██████████] 100.0%");
    });
  });

  describe("Usage Data Collection", () => {
    it("collects token accounting and context window metrics", () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("gemini", ["AIzaSyTestKey1234567890"]);
      keyPool.registerKeys("nvidia", ["nvapi-test-nvidia-key"]);

      const data = collectUsageData(mockContext);

      expect(data.tokenUsage.inputTokens).toBe(14250);
      expect(data.tokenUsage.outputTokens).toBe(3820);
      expect(data.tokenUsage.cacheReadTokens).toBe(12400);
      expect(data.tokenUsage.cacheWriteTokens).toBe(1100);
      expect(data.tokenUsage.totalTokens).toBe(31570);

      expect(data.contextWindow.model).toBe("gemini-2.5-flash");
      expect(data.contextWindow.messageCount).toBe(2);
      expect(data.contextWindow.conversationTokens).toBeGreaterThan(0);
      expect(data.fallbackChain.primaryProvider).toBe("gemini");
      expect(data.fallbackChain.activeProvider).toBe("gemini");
    });
  });

  describe("Slash Command Execution", () => {
    it("renders full dashboard on default /usage", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("gemini", ["AIzaSyTestKey1234567890"]);
      keyPool.registerKeys("nvidia", ["nvapi-test-nvidia-key"]);

      const res = await usageCommand.execute("", mockContext);
      expect(res.type).toBe("message");
      const text = (res as any).text;

      // Check header & sections
      expect(text).toContain("Agav Session & Usage Dashboard");
      expect(text).toContain("Session Token Accounting:");
      expect(text).toContain("14,250");
      expect(text).toContain("3,820");
      expect(text).toContain("31,570 tokens");

      // Check context saturation
      expect(text).toContain("Context Window Saturation:");
      expect(text).toContain("gemini-2.5-flash");

      // Check key pools & masking
      expect(text).toContain("Multi-API-Key Provider Pools:");
      expect(text).toContain("gemini (1 key)");
      expect(text).toContain("HEALTHY");

      // Check fallback chain
      expect(text).toContain("Auto-Fallback Cascade Chain:");
      expect(text).toContain("Primary Provider:    gemini");
      expect(text).toContain("ACTIVE");
    });

    it("renders token metrics only on /usage tokens", async () => {
      const res = await usageCommand.execute("tokens", mockContext);
      const text = (res as any).text;

      expect(text).toContain("Session Token Accounting:");
      expect(text).toContain("Context Window Saturation:");
      expect(text).not.toContain("Multi-API-Key Provider Pools:");
    });

    it("renders key pools on /usage keys", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("groq", ["gsk_test1", "gsk_test2"]);

      const res = await usageCommand.execute("keys", mockContext);
      const text = (res as any).text;

      expect(text).toContain("Multi-API-Key Provider Pools:");
      expect(text).toContain("groq (2 keys)");
      expect(text).toContain("[Key #1]");
      expect(text).toContain("[Key #2]");
      expect(text).not.toContain("Session Token Accounting:");
    });

    it("renders fallback chain on /usage chain", async () => {
      const res = await usageCommand.execute("chain", mockContext);
      const text = (res as any).text;

      expect(text).toContain("Auto-Fallback Cascade Chain:");
      expect(text).toContain("Priority Sequence:");
      expect(text).not.toContain("Session Token Accounting:");
    });

    it("outputs valid JSON on /usage json", async () => {
      const res = await usageCommand.execute("json", mockContext);
      const text = (res as any).text;

      const parsed = JSON.parse(text);
      expect(parsed.tokenUsage.totalTokens).toBe(31570);
      expect(parsed.contextWindow.model).toBe("gemini-2.5-flash");
      expect(parsed.fallbackChain.primaryProvider).toBe("gemini");
    });

    it("displays cooling countdown when a key or provider is cooling down", async () => {
      const keyPool = KeyPoolManager.getInstance();
      keyPool.registerKeys("gemini", ["gemini-key-1"]);
      keyPool.reportRateLimit("gemini", "gemini-key-1", 45000);

      const res = await usageCommand.execute("keys", mockContext);
      const text = (res as any).text;

      expect(text).toContain("COOLING");
      expect(text).toMatch(/\d+s remaining/);
    });
  });
});
