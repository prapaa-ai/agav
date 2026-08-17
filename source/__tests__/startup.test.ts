import { describe, expect, it } from "vitest";
import type { AgavConfig } from "../config/config.js";
import {
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

describe("startup provider and model resolution", () => {
  it("keeps configured selection for plain startup", () => {
    expect(resolveStartupSelection(base, {})).toMatchObject({
      provider: "anthropic",
      model: "configured-claude",
    });
  });

  it("uses the selected provider default when --provider changes provider", () => {
    expect(resolveStartupSelection(base, { cliProvider: "openai" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("restores both provider and model from a resumed session", () => {
    expect(resolveStartupSelection(base, {
      session: { provider: "gemini", model: "gemini-session-model" },
    })).toMatchObject({ provider: "gemini", model: "gemini-session-model" });
  });

  it("does not combine a CLI provider override with another provider's saved model", () => {
    expect(resolveStartupSelection(base, {
      cliProvider: "openai",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("retains the saved model when the CLI provider matches the session", () => {
    expect(resolveStartupSelection(base, {
      cliProvider: "anthropic",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "anthropic", model: "claude-session-model" });
  });

  it("lets an explicit model override every default and saved model", () => {
    expect(resolveStartupSelection(base, {
      cliProvider: "openai",
      cliModel: "custom-openai-model",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "openai", model: "custom-openai-model" });
  });

  it("rejects an unsupported saved provider unless the CLI replaces it", () => {
    expect(() => resolveStartupSelection(base, {
      session: { provider: "removed-provider", model: "old-model" },
    })).toThrow("Saved session uses unsupported provider");

    expect(resolveStartupSelection(base, {
      cliProvider: "gemini",
      session: { provider: "removed-provider", model: "old-model" },
    })).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite" });
  });

  it("auto-selects an available provider only for an unpinned startup", () => {
    expect(selectConfiguredProvider({ ...base, openaiApiKey: "key" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("reports the selected provider's exact missing configuration", () => {
    expect(providerConfigurationError({ ...base, provider: "vertex-ai", model: "vertex/gemini" }))
      .toContain("AGAV_USE_VERTEX_AI=true, VERTEX_AI_CREDENTIALS_PATH");
  });
});
