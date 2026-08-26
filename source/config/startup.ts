import type { AgavConfig } from "./config.js";
import type { SessionRecord } from "./history.js";
import { agavHomePath, examplePath, setEnvHint } from "../utils/shell-hints.js";

export type ProviderName = AgavConfig["provider"];

export const PROVIDERS: readonly ProviderName[] = [
  "anthropic",
  "openai",
  "openrouter",
  "gemini",
  "vertex-ai",
  "ollama",
];

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-5.4-mini",
  openrouter: "openrouter/auto",
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
    case "openrouter": return Boolean(config.openrouterApiKey);
    case "gemini": return Boolean(config.geminiApiKey);
    case "vertex-ai": return Boolean(config.vertexAICredentialsPath);
    case "ollama": return true;
  }
}

interface SelectProviderOptions {
  /**
   * Keep `config.model` as-is instead of substituting the newly selected
   * provider's default. Set when the user named a model explicitly.
   */
  keepModel?: boolean;
}

/** For an unpinned plain start, select the first configured cloud provider. */
export function selectConfiguredProvider(
  config: AgavConfig,
  options: SelectProviderOptions = {},
): AgavConfig | null {
  if (hasProviderConfiguration(config, config.provider)) return { ...config };

  for (const provider of PROVIDERS) {
    if (provider === "ollama" || !hasProviderConfiguration(config, provider)) continue;
    // An explicit --model is a deliberate choice, so only fall back to the
    // provider default when the user did not name a model themselves.
    if (options.keepModel) return { ...config, provider };
    return { ...config, provider, model: defaultModelForProvider(provider) };
  }
  return null;
}

/**
 * The set-up commands for every provider, spelled out for the caller's shell
 * rather than telling them to "set an API key" and leaving them to work out the
 * syntax. Shared so a caller with its own lead-in sentence does not have to
 * restate them.
 */
export function providerSetupHints(): string {
  return [
    "  Set one of:",
    `    ${setEnvHint("ANTHROPIC_API_KEY", "sk-ant-...")}`,
    `    ${setEnvHint("OPENAI_API_KEY", "sk-...")}`,
    `    ${setEnvHint("OPENROUTER_API_KEY", "sk-or-v1-...")}`,
    `    ${setEnvHint("GEMINI_API_KEY", "...")}`,
    `    ${setEnvHint("VERTEX_AI_CREDENTIALS_PATH", examplePath("path", "to", "service-account.json"))}`,
    "  Or start Ollama: agav --provider ollama",
  ].join("\n");
}

/** Guidance for a plain start with nothing configured at all. */
export function noProviderCredentialsError(): string {
  return `no provider credentials found.\n${providerSetupHints()}`;
}

export function providerConfigurationError(config: AgavConfig): string | null {
  switch (config.provider) {
    case "anthropic":
      return config.anthropicApiKey ? null
        : `Anthropic API key not found. Run ${setEnvHint("ANTHROPIC_API_KEY", "sk-ant-...")} or add it to ${agavHomePath("config.json")}`;
    case "openai":
      return config.openaiApiKey ? null
        : `OpenAI API key not found. Run ${setEnvHint("OPENAI_API_KEY", "sk-...")} or add it to ${agavHomePath("config.json")}`;
    case "openrouter":
      return config.openrouterApiKey ? null
        : `OpenRouter API key not found. Run ${setEnvHint("OPENROUTER_API_KEY", "sk-or-v1-...")} or add it to ${agavHomePath("config.json")}`;
    case "gemini":
      return config.geminiApiKey ? null
        : `Gemini API key not found. Run ${setEnvHint("GEMINI_API_KEY", "...")} or add it to ${agavHomePath("config.json")}`;
    case "vertex-ai":
      return config.vertexAICredentialsPath ? null
        : `Vertex AI service account credentials not found. Run ${setEnvHint("VERTEX_AI_CREDENTIALS_PATH", examplePath("path", "to", "service-account.json"))} or add it to ${agavHomePath("config.json")}`;
    case "ollama": return null;
  }
}
