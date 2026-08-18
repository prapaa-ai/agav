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
});

const route = async (command: typeof fastCommand, provider: AgavConfig["provider"]) => {
  const context = createContext(provider);
  await command.execute("", context);
  return (context.setModel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
};

// Ollama models are whatever the user has pulled locally, so a static table
// cannot name one — every other provider must be covered.
const CLOUD_PROVIDERS = PROVIDERS.filter((provider) => provider !== "ollama");

describe("commands/model-routing", () => {
  it("/fast routes each provider to its own model", async () => {
    await expect(route(fastCommand, "anthropic")).resolves.toBe("claude-haiku-4-5-20251001");
    await expect(route(fastCommand, "openai")).resolves.toBe("gpt-4o-mini");
    await expect(route(fastCommand, "gemini")).resolves.toBe("gemini-3.5-flash-lite");
    await expect(route(fastCommand, "vertex-ai")).resolves.toBe("vertex/gemini-3.5-flash-lite");
  });

  it("/deep routes each provider to its own model", async () => {
    await expect(route(deepCommand, "anthropic")).resolves.toBe("claude-sonnet-4-20250514");
    await expect(route(deepCommand, "openai")).resolves.toBe("gpt-4o");
    await expect(route(deepCommand, "gemini")).resolves.toBe("gemini-3.5-pro");
    await expect(route(deepCommand, "vertex-ai")).resolves.toBe("vertex/gemini-3.5-pro");
  });

  it("never silently falls back to an OpenAI model for another provider", async () => {
    for (const provider of CLOUD_PROVIDERS) {
      if (provider === "openai") continue;
      await expect(route(fastCommand, provider)).resolves.not.toMatch(/^gpt-/);
      await expect(route(deepCommand, provider)).resolves.not.toMatch(/^gpt-/);
    }
  });

  it("addresses Vertex AI models with the vertex/ prefix the provider expects", async () => {
    await expect(route(fastCommand, "vertex-ai")).resolves.toMatch(/^vertex\//);
    await expect(route(deepCommand, "vertex-ai")).resolves.toMatch(/^vertex\//);
  });
});
