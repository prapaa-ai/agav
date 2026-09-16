import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import { listSessions } from "../config/history.js";
import {
  noProviderCredentialsError,
  providerConfigurationError,
  resolveStartupSelection,
  selectConfiguredProvider,
} from "../config/startup.js";

const base: AgavConfig = {
  provider: "anthropic",
  model: "configured-claude",
  effort: "high",
  maxTokens: 1024,
  maxIterations: 10,
  errorRetries: 1,
  permissionMode: "ask",
};

vi.mock("../config/history.js", () => ({
  listSessions: vi.fn(),
}));


describe("startup provider and model resolution", () => {
  it("keeps configured selection for plain startup", async () => {
    expect(await resolveStartupSelection(base, {})).toMatchObject({
      provider: "anthropic",
      model: "configured-claude",
    });
  });

  it("uses the selected provider default when --provider changes provider", async () => {
    expect(await resolveStartupSelection(base, { cliProvider: "openai" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(await resolveStartupSelection(base, { cliProvider: "openrouter" })).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
    });
  });

  it("restores both provider and model from a resumed session", async () => {
    expect(await resolveStartupSelection(base, {
      session: { provider: "gemini", model: "gemini-session-model" },
    })).toMatchObject({ provider: "gemini", model: "gemini-session-model" });
  });

  it("does not combine a CLI provider override with another provider's saved model", async () => {
    expect(await resolveStartupSelection(base, {
      cliProvider: "openai",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("retains the saved model when the CLI provider matches the session", async () => {
    expect(await resolveStartupSelection(base, {
      cliProvider: "anthropic",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "anthropic", model: "claude-session-model" });
  });

  it("keeps an explicit provider/model pair authoritative", async () => {
    expect(await resolveStartupSelection(base, {
      cliProvider: "openai",
      cliModel: "custom-openai-model",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "openai", model: "custom-openai-model" });
  });

  it("preserves an unqualified CLI model until catalog resolution selects its provider", async () => {
    expect(await resolveStartupSelection({ ...base, provider: "openai", model: "gpt-5.4-mini" }, {
      cliModel: "sonnet-5",
    })).toMatchObject({ provider: "openai", model: "sonnet-5" });
  });

  it("retains an unmatched CLI model when provider catalog lookup cannot resolve it", async () => {
    expect(await resolveStartupSelection({ ...base, provider: "openai", model: "gpt-5.4-mini" }, {
      cliModel: "private-model",
    })).toMatchObject({ provider: "openai", model: "private-model" });
  });


  it("rejects an unsupported saved provider unless the CLI replaces it", async () => {
    await expect(
      resolveStartupSelection(base, {
        session: { provider: "removed-provider", model: "old-model" },
      })
    ).rejects.toThrow("Saved session uses unsupported provider");

    expect(
      await resolveStartupSelection(base, {
        cliProvider: "gemini",
        session: { provider: "removed-provider", model: "old-model" },
      })
    ).toMatchObject({ provider: "gemini", model: "gemini-flash-lite-latest" });
  });

  it("auto-selects an available provider only for an unpinned startup", () => {
    expect(selectConfiguredProvider({ ...base, openaiApiKey: "key" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(selectConfiguredProvider({ ...base, openrouterApiKey: "key" })).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
    });
  });

  it("keeps an explicit --model when falling back to another provider", () => {
    expect(selectConfiguredProvider({ ...base, model: "gpt-4o", openaiApiKey: "key" }, { keepModel: true }))
      .toMatchObject({ provider: "openai", model: "gpt-4o" });
  });

  it("enables Vertex AI from the credentials path alone", () => {
    const config: AgavConfig = { ...base, provider: "vertex-ai", model: "vertex/gemini-3.5-flash" };
    expect(providerConfigurationError(config)).toContain("VERTEX_AI_CREDENTIALS_PATH");
    expect(providerConfigurationError({ ...config, vertexAICredentialsPath: "/tmp/sa.json" })).toBeNull();
  });

  it("names a runnable command for every provider when nothing is configured", () => {
    const message = noProviderCredentialsError();
    for (const variable of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "VERTEX_AI_CREDENTIALS_PATH"]) {
      // The shell-specific prefix is covered by utils.shell-hints; here it only
      // matters that each variable is shown as a command, not just named.
      expect(message).toMatch(new RegExp(`(export|set|\\$env:)\\s?${variable}`));
    }
    expect(message).toContain("agav --provider ollama");
  });

  it("reports the selected provider's exact missing configuration", () => {
    expect(providerConfigurationError({ ...base, anthropicApiKey: undefined }))
      .toContain("ANTHROPIC_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openai", openaiApiKey: undefined }))
      .toContain("OPENAI_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openrouter", openrouterApiKey: undefined }))
      .toContain("OPENROUTER_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openrouter", openrouterApiKey: "sk-or-test" }))
      .toBeNull();
  });
});

describe("listSessions and recent session startup resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to the most recent session's model and provider on plain startup", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "session-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        title: "Saved Session",
        messages: [],
      },
    ]);
    const selection = await resolveStartupSelection(base, {});
    expect(selection).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("prefers explicit CLI provider over saved session history", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "session-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        title: "Saved Session",
        messages: [],
      },
    ]);
    const selection = await resolveStartupSelection(base, { cliProvider: "anthropic" });
    expect(selection).toMatchObject({
      provider: "anthropic",
      model: "configured-claude",
    });
  });

  it("returns empty array if no history exists", async () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });
});
