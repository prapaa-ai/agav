import type { AgavConfig } from "./config.js";
import type { SessionRecord } from "./history.js";
import { agavHomePath } from "../utils/shell-hints.js";

export type ProviderName = AgavConfig["provider"];

export const PROVIDERS: readonly ProviderName[] = [
  "anthropic",
  "openai",
  "gemini",
  "vertex-ai",
  "ollama",
];

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-5.4-mini",
  gemini: "gemini-3.5-flash-lite",
  "vertex-ai": "vertex/gemini-3.5-flash",
  ollama: "",
};

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && PROVIDERS.includes(value as ProviderName);
}

export function defaultModelForProvider(provider: ProviderName): string {
  return DEFAULT_MODELS[provider];
}

interface StartupSelectionOptions {
  cliProvider?: ProviderName;
  cliModel?: string;
  session?: Pick<SessionRecord, "provider" | "model">;
}

/** Resolve provider/model precedence before validating any provider credentials. */
export function resolveStartupSelection(
  config: AgavConfig,
  options: StartupSelectionOptions,
): AgavConfig {
  const result = { ...config };
  const sessionProvider = isProviderName(options.session?.provider)
    ? options.session.provider
    : undefined;

  if (options.session && !sessionProvider && !options.cliProvider) {
    throw new Error(
      `Saved session uses unsupported provider ${JSON.stringify(options.session.provider)}. ` +
      "Resume it with --provider <provider> to choose a supported provider.",
    );
  }

  if (options.cliProvider) {
    const providerChanged = options.cliProvider !== result.provider;
    result.provider = options.cliProvider;

    if (options.cliModel !== undefined) {
      result.model = options.cliModel;
    } else if (options.session) {
      // Reuse the saved model only when it belongs to the selected provider.
      result.model = sessionProvider === options.cliProvider
        ? options.session.model || defaultModelForProvider(options.cliProvider)
        : defaultModelForProvider(options.cliProvider);
    } else if (providerChanged) {
      result.model = defaultModelForProvider(options.cliProvider);
    }
  } else if (options.session && sessionProvider) {
    result.provider = sessionProvider;
    result.model = options.cliModel ?? (options.session.model || defaultModelForProvider(sessionProvider));
  } else if (options.cliModel !== undefined) {
    result.model = options.cliModel;
  }

  return result;
}

export function hasProviderConfiguration(config: AgavConfig, provider: ProviderName): boolean {
  switch (provider) {
    case "anthropic": return Boolean(config.anthropicApiKey);
    case "openai": return Boolean(config.openaiApiKey);
    case "gemini": return Boolean(config.geminiApiKey);
    case "vertex-ai": return Boolean(config.AGAV_USE_VERTEX_AI && config.VERTEX_AI_CREDENTIALS_PATH);
    case "ollama": return true;
  }
}

/** For an unpinned plain start, select the first configured cloud provider. */
export function selectConfiguredProvider(config: AgavConfig): AgavConfig | null {
  if (hasProviderConfiguration(config, config.provider)) return { ...config };

  for (const provider of PROVIDERS) {
    if (provider === "ollama" || !hasProviderConfiguration(config, provider)) continue;
    return { ...config, provider, model: defaultModelForProvider(provider) };
  }
  return null;
}

export function providerConfigurationError(config: AgavConfig): string | null {
  switch (config.provider) {
    case "anthropic":
      return config.anthropicApiKey ? null
        : `Anthropic API key not found. Set ANTHROPIC_API_KEY or add it to ${agavHomePath("config.json")}`;
    case "openai":
      return config.openaiApiKey ? null
        : `OpenAI API key not found. Set OPENAI_API_KEY or add it to ${agavHomePath("config.json")}`;
    case "gemini":
      return config.geminiApiKey ? null
        : `Gemini API key not found. Set GEMINI_API_KEY or add it to ${agavHomePath("config.json")}`;
    case "vertex-ai": {
      const missing: string[] = [];
      if (!config.AGAV_USE_VERTEX_AI) missing.push("AGAV_USE_VERTEX_AI=true");
      if (!config.VERTEX_AI_CREDENTIALS_PATH) missing.push("VERTEX_AI_CREDENTIALS_PATH");
      return missing.length === 0 ? null
        : `Vertex AI configuration is incomplete. Missing: ${missing.join(", ")}. Add it to the environment or ${agavHomePath("config.json")}`;
    }
    case "ollama": return null;
  }
}
