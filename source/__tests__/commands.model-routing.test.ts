import { describe, expect, it, vi } from "vitest";

import { deepCommand, fastCommand } from "../commands/model-routing.js";
import type { CommandContext } from "../commands/types.js";
import type { AgavConfig } from "../config/config.js";
import { PROVIDERS } from "../config/startup.js";

const createContext = (provider: AgavConfig["provider"]): CommandContext => ({
  conversation: {} as any,
  config: { provider } as any,
  setModel: vi.fn(),
  setProvider: vi.fn(),
  setEffort: vi.fn(),
  clearMessages: vi.fn(),
  refreshPlan: vi.fn(),
  showStatus: vi.fn(),
  saveSession: vi.fn(),
  refreshDisplay: vi.fn(),
  loadSession: vi.fn(),
  activateSession: vi.fn(),
  renameSession: vi.fn(),
  exit: vi.fn(),
  getDebugState: vi.fn(),
  submit: vi.fn(),
  handleSubmit: vi.fn(),
  toolRegistry: {} as any,
  addTokenUsage: vi.fn(),
  setRunningSkill: vi.fn(),
  setPickerActive: vi.fn(),
  suspendTerminal: vi.fn(() => vi.fn()),
  showAgentsTUI: vi.fn(),
  showSkillsTUI: vi.fn(),
});

const route = async (command: typeof fastCommand, provider: AgavConfig["provider"]) => {
  const context = createContext(provider);
  await command.execute("", context);
  return (context.setModel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
};

const ROUTED_PROVIDERS = PROVIDERS;

describe("commands/model-routing", () => {
  it("/fast routes each provider to its own model", async () => {
    await expect(route(fastCommand, "anthropic")).resolves.toBe("claude-haiku-5-5");
    await expect(route(fastCommand, "openai")).resolves.toBe("gpt-6-luna");
    await expect(route(fastCommand, "openrouter")).resolves.toBe("nvidia/nemotron-3.5-lightning:free");
    await expect(route(fastCommand, "nvidia")).resolves.toBe("nvidia/nemotron-3.5-bolt-e4b");
    await expect(route(fastCommand, "deepseek")).resolves.toBe("deepseek-flash");
    await expect(route(fastCommand, "gemini")).resolves.toBe("gemini-3.8-flash");
    await expect(route(fastCommand, "vertex-ai")).resolves.toBe("vertex/gemini-3.8-flash");
    await expect(route(fastCommand, "ollama")).resolves.toBe("gemma4:e4b");
  });

  it("/deep routes each provider to its own model", async () => {
    await expect(route(deepCommand, "anthropic")).resolves.toBe("claude-opus-5-5");
    await expect(route(deepCommand, "openai")).resolves.toBe("gpt-6.1-sol");
    await expect(route(deepCommand, "openrouter")).resolves.toBe("anthropic/claude-fable-5.1");
    await expect(route(deepCommand, "nvidia")).resolves.toBe("nvidia/nemotron-3-ultra-550b-a55b");
    await expect(route(deepCommand, "deepseek")).resolves.toBe("deepseek-v4-pro");
    await expect(route(deepCommand, "gemini")).resolves.toBe("gemini-3.1-pro-preview");
    await expect(route(deepCommand, "vertex-ai")).resolves.toBe("vertex/claude-opus-5-5");
    await expect(route(deepCommand, "ollama")).resolves.toBe("qwen3.8:27b");
  });

  it("never silently falls back to an OpenAI model for another provider", async () => {
    for (const provider of ROUTED_PROVIDERS) {
      if (provider === "openai" || provider === "ollama") continue;
      await expect(route(fastCommand, provider)).resolves.not.toMatch(/^gpt-/);
      await expect(route(deepCommand, provider)).resolves.not.toMatch(/^gpt-/);
    }
  });

  it("addresses Vertex AI models with the vertex/ prefix the provider expects", async () => {
    await expect(route(fastCommand, "vertex-ai")).resolves.toMatch(/^vertex\//);
    await expect(route(deepCommand, "vertex-ai")).resolves.toMatch(/^vertex\//);
  });

  it("reports the policy error instead of a success message when the change is rejected", async () => {
    // A rejected model change (e.g. org allowlist) must not surface a misleading
    // "Switched to …" result.
    const context = createContext("openai");
    (context.setModel as ReturnType<typeof vi.fn>).mockReturnValue(
      'Model "gpt-6-luna" is not permitted by your organization\'s policy.',
    );
    const result = await fastCommand.execute("", context);
    expect(result).toMatchObject({ type: "message" });
    expect((result as { text: string }).text).toContain("not permitted by your organization");
    expect((result as { text: string }).text).not.toContain("Switched to fast model");
  });

  it("reports success when the change is accepted", async () => {
    const context = createContext("openai");
    (context.setModel as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await deepCommand.execute("", context);
    expect((result as { text: string }).text).toContain("Switched to deep model");
  });
});

describe("Vertex deep location compatibility", () => {
  it("rejects a regional switch without changing model or location", async () => {
    const context = createContext("vertex-ai");
    context.config.vertexAILocation = "us-east5";
    const result = await deepCommand.execute("", context);
    expect(context.setModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "message", text: expect.stringContaining("vertexAILocation") });
    expect((result as { text: string }).text).toContain("global");
    expect(context.config.vertexAILocation).toBe("us-east5");
  });
  it.each([undefined, "global", "us", "eu"])("accepts location %s", async (location) => {
    const context = createContext("vertex-ai");
    context.config.vertexAILocation = location;
    await deepCommand.execute("", context);
    expect(context.setModel).toHaveBeenCalledWith("vertex/claude-opus-5-5");
    expect(context.config.vertexAILocation).toBe(location);
  });
});
