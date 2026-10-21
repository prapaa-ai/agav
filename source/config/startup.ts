import { type AgavConfig } from "./config.js";
import type { SessionRecord } from "./history.js";
import { agavHomePath, examplePath, setEnvHint } from "../utils/shell-hints.js";
import { listSessions } from "./history.js";
import { managedPinError } from "./org-config.js";
import {
  PROVIDERS,
  defaultModelForProvider,
  isProviderName,
  type ProviderName,
} from "./provider-defaults.js";

// Re-exported for existing importers (provider defaults now live in a tiny
// standalone module shared with the org-policy layer).
export { PROVIDERS, defaultModelForProvider, isProviderName };
export type { ProviderName };

interface StartupSelectionOptions {
  cliProvider?: ProviderName;
  cliModel?: string;
  session?: Pick<SessionRecord, "provider" | "model">;
}

/** Resolve provider/model precedence before validating any provider credentials. */
export async function resolveStartupSelection(
  config: AgavConfig,
  options: StartupSelectionOptions,
): Promise<AgavConfig> {
  const result = { ...config };
  // The configured provider before any session/history override — this is the
  // provider the pinned model (if any) is paired with, used to restore a
  // compatible pair when an implicit selection changes the provider.
  const configuredProvider = result.provider;
  const sessionProvider = isProviderName(options.session?.provider)
    ? options.session.provider
    : undefined;

  if (options.session && !sessionProvider && !options.cliProvider) {
    throw new Error(
      `Saved session uses unsupported provider ${JSON.stringify(options.session.provider)}. ` +
      "Resume it with --provider <provider> to choose a supported provider.",
    );
  }

  // The provider that `result.model` belongs to, tracked so a managed pin can
  // reconcile the pair rather than keeping a model from a different provider.
  let modelSourceProvider: ProviderName = result.provider;

  if (options.cliProvider) {
    const providerChanged = options.cliProvider !== result.provider;
    result.provider = options.cliProvider;
    modelSourceProvider = options.cliProvider;

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
    modelSourceProvider = sessionProvider;
  } else if (options.cliModel !== undefined) {
    result.model = options.cliModel;
  } else {
    // Plain start: fall back to the most recent session's provider+model as a
    // pair — but only when it does not conflict with a managed pin. A partial pin
    // (provider-only or model-only) must not be paired with the other field from
    // an incompatible session, which would produce a provider/model mismatch that
    // still passes credential validation but fails at generation time.
    const recentSessions = (await listSessions()) || [];
    const lastSession = recentSessions.length ? recentSessions[0] : undefined;
    if (lastSession && isProviderName(lastSession.provider)) {
      const conflictsWithProviderPin = result.orgManagedProvider !== undefined
        && lastSession.provider !== result.orgManagedProvider;
      const conflictsWithModelPin = result.orgManagedModel !== undefined
        && lastSession.model !== result.orgManagedModel;
      if (!conflictsWithProviderPin && !conflictsWithModelPin) {
        result.provider = lastSession.provider;
        result.model = lastSession.model;
        modelSourceProvider = lastSession.provider;
      }
    }
  }

  // Re-assert managed hard pins as a *compatible pair*. Explicit CLI flags are
  // intentionally NOT corrected — an out-of-policy `--provider`/`--model` must
  // still be rejected by orgPolicyError rather than silently overridden.
  if (result.orgManagedProvider !== undefined && options.cliProvider === undefined) {
    const providerChanged = result.provider !== result.orgManagedProvider;
    result.provider = result.orgManagedProvider;
    // If the pin forced a provider change and the carried model belonged to the
    // old provider (not a model pin, no explicit model), the model no longer
    // matches the provider. Reset it to the pinned provider's default so the pair
    // is coherent instead of e.g. openai + claude-sonnet.
    if (
      providerChanged
      && modelSourceProvider !== result.orgManagedProvider
      && result.orgManagedModel === undefined
      && options.cliModel === undefined
    ) {
      result.model = defaultModelForProvider(result.orgManagedProvider);
    }
  }
  if (result.orgManagedModel !== undefined && options.cliModel === undefined) {
    // Model pinned, provider not pinned: an implicit session/history selection
    // may have changed the provider away from the configured one that the pinned
    // model pairs with (e.g. resuming Anthropic under a gpt-5.4-mini pin yields
    // anthropic + gpt-5.4-mini). Restore the configured provider so the pair is
    // compatible. An explicit --provider is left for orgPolicyError to judge.
    if (
      result.orgManagedProvider === undefined
      && options.cliProvider === undefined
      && result.provider !== configuredProvider
    ) {
      result.provider = configuredProvider;
    }
    result.model = result.orgManagedModel;
  }

  return result;
}

export function hasProviderConfiguration(config: AgavConfig, provider: ProviderName): boolean {
  switch (provider) {
    case "anthropic": return Boolean(config.anthropicApiKey);
    // An enrollment gateway token authenticates the OpenAI-compatible endpoint,
    // so a personal key is not required when gateway auth is present.
    case "openai": return Boolean(config.openaiApiKey) || Boolean(config.openaiGatewayAuth);
    case "openrouter": return Boolean(config.openrouterApiKey);
    case "nvidia": return Boolean(config.nvidiaApiKey);
    case "deepseek": return Boolean(config.deepseekApiKey);
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
    `    ${setEnvHint("NVIDIA_API_KEY", "nvapi-...")}`,
    `    ${setEnvHint("DEEPSEEK_API_KEY", "sk-...")}`,
    `    ${setEnvHint("GEMINI_API_KEY", "...")}`,
    `    ${setEnvHint("VERTEX_AI_CREDENTIALS_PATH", examplePath("path", "to", "service-account.json"))}`,
    "  Or start Ollama: agav --provider ollama",
  ].join("\n");
}

/** Guidance for a plain start with nothing configured at all. */
export function noProviderCredentialsError(): string {
  return `no provider credentials found.\n${providerSetupHints()}`;
}

/**
 * Enforce organization selection policy: if an admin restricted which providers
 * or models may be used (org tier, see config/org-config.ts), reject a config
 * whose chosen provider/model falls outside the allowlist. Returns null when no
 * org restriction applies or the selection is permitted.
 *
 * Checked before credential errors so an out-of-policy choice is reported as a
 * policy violation rather than a missing-key message.
 */
export function orgPolicyError(config: AgavConfig): string | null {
  // Hard pins are mandatory and are not expressed as singleton allowlists, so
  // check them first. They survive startup routing/fallback and later selection.
  const pinError = managedPinError(config);
  if (pinError) return pinError;

  if (config.orgAllowedProviders && config.orgAllowedProviders.length > 0
    && !config.orgAllowedProviders.includes(config.provider)) {
    return `Provider ${JSON.stringify(config.provider)} is not permitted by your organization's policy. ` +
      `Allowed providers: ${config.orgAllowedProviders.join(", ")}.`;
  }
  if (config.orgAllowedModels && config.orgAllowedModels.length > 0
    && !config.orgAllowedModels.includes(config.model)) {
    return `Model ${JSON.stringify(config.model)} is not permitted by your organization's policy. ` +
      `Allowed models: ${config.orgAllowedModels.join(", ")}.`;
  }
  return null;
}

export function providerConfigurationError(config: AgavConfig): string | null {
  const policyError = orgPolicyError(config);
  if (policyError) return policyError;

  switch (config.provider) {
    case "anthropic":
      return config.anthropicApiKey ? null
        : `Anthropic API key not found. Run ${setEnvHint("ANTHROPIC_API_KEY", "sk-ant-...")} or add it to ${agavHomePath("config.json")}`;
    case "openai":
      // Gateway auth (an enrollment token injected as the Authorization header)
      // satisfies the OpenAI credential requirement without a personal key.
      return config.openaiApiKey || config.openaiGatewayAuth ? null
        : `OpenAI API key not found. Run ${setEnvHint("OPENAI_API_KEY", "sk-...")} or add it to ${agavHomePath("config.json")}`;
    case "openrouter":
      return config.openrouterApiKey ? null
        : `OpenRouter API key not found. Run ${setEnvHint("OPENROUTER_API_KEY", "sk-or-v1-...")} or add it to ${agavHomePath("config.json")}`;
    case "nvidia":
      return config.nvidiaApiKey ? null
        : `NVIDIA API key not found. Run ${setEnvHint("NVIDIA_API_KEY", "nvapi-...")} or add it to ${agavHomePath("config.json")}`;
    case "deepseek":
      return config.deepseekApiKey ? null
        : `DeepSeek API key not found. Run ${setEnvHint("DEEPSEEK_API_KEY", "sk-...")} or add it to ${agavHomePath("config.json")}`;
    case "gemini":
      return config.geminiApiKey ? null
        : `Gemini API key not found. Run ${setEnvHint("GEMINI_API_KEY", "...")} or add it to ${agavHomePath("config.json")}`;
    case "vertex-ai":
      return config.vertexAICredentialsPath ? null
        : `Vertex AI service account credentials not found. Run ${setEnvHint("VERTEX_AI_CREDENTIALS_PATH", examplePath("path", "to", "service-account.json"))} or add it to ${agavHomePath("config.json")}`;
    case "ollama": return null;
  }
}

/**
 * Resolve the initial session name for startup.
 * Explicit non-empty CLI name sets the initial name for new sessions.
 * Resuming an existing session preserves the existing session's name and avoids renaming it.
 */
export function resolveInitialSessionName(
  cliName?: string,
  resumedSession?: { id?: string; name?: string },
): string | undefined {
  if (resumedSession?.id) {
    return resumedSession.name;
  }
  return typeof cliName === "string" && cliName.trim() ? cliName.trim() : undefined;
}
