import type { LLMProvider } from "./types.js";
import type { AgavConfig } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { NvidiaProvider } from "./nvidia.js";
import { DeepSeekProvider } from "./deepseek.js";
import { OllamaProvider } from "./ollama.js";
import { GeminiProvider } from "./gemini.js";
import { VertexAIProvider } from "./vertex-ai.js";
import { GroqProvider } from "./groq.js";
import { RetryProvider } from "./retry.js";
import { KeyPoolManager } from "./key-pool.js";
import { KeyPoolProvider } from "./key-pool-provider.js";
import { FallbackMeshProvider, DEFAULT_FALLBACK_ORDER } from "./fallback-mesh.js";
import { providerConfigurationError, PROVIDERS } from "../config/startup.js";

/**
 * Extracts configured API keys (single or multiple) for a provider from AgavConfig.
 */
export function extractConfiguredKeys(config: AgavConfig, provider: string): string[] {
  const pluralKey = `${provider}ApiKeys` as keyof AgavConfig;
  const pluralVal = config[pluralKey];
  if (Array.isArray(pluralVal)) {
    return (pluralVal as string[])
      .filter((k) => typeof k === "string" && k.trim().length > 0)
      .map((k) => k.trim());
  }

  let singularKeyVal: string | undefined;
  switch (provider) {
    case "anthropic":
      singularKeyVal = config.anthropicApiKey;
      break;
    case "openai":
      singularKeyVal = config.openaiApiKey;
      break;
    case "openrouter":
      singularKeyVal = config.openrouterApiKey;
      break;
    case "nvidia":
      singularKeyVal = config.nvidiaApiKey;
      break;
    case "deepseek":
      singularKeyVal = config.deepseekApiKey;
      break;
    case "gemini":
      singularKeyVal = config.geminiApiKey;
      break;
    case "groq":
      singularKeyVal = config.groqApiKey;
      break;
    case "ollama":
      singularKeyVal = config.ollamaApiKey;
      break;
    case "vertex-ai":
      singularKeyVal = config.vertexAICredentialsPath;
      break;
  }

  if (!singularKeyVal) return [];

  if (singularKeyVal.includes(",") || singularKeyVal.includes("\n")) {
    return singularKeyVal
      .split(/[,\n]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }

  return [singularKeyVal.trim()];
}

function required(value: string | undefined, description: string): string {
  if (!value) throw new Error(`${description} is missing from the resolved configuration`);
  return value;
}

export function createBaseProvider(provider: string, key: string, config: AgavConfig): LLMProvider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(key);
    case "openai":
      return new OpenAIProvider(key, config.openaiApi ?? "responses", {
        baseURL: config.openaiBaseURL,
        defaultHeaders: config.openaiHeaders,
      });
    case "openrouter":
      return new OpenRouterProvider(key);
    case "nvidia":
      return new NvidiaProvider(key);
    case "deepseek":
      return new DeepSeekProvider(key);
    case "groq":
      return new GroqProvider(key);
    case "ollama": {
      const baseURL =
        config.ollamaEndpoint ??
        `http://${config.ollamaHost ?? "localhost"}:${config.ollamaPort ?? 11434}`;
      return new OllamaProvider(baseURL, key || config.ollamaApiKey);
    }
    case "gemini":
      return new GeminiProvider(key);
    case "vertex-ai":
      return new VertexAIProvider(key, config.vertexAILocation);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function createProvider(config: AgavConfig): LLMProvider {
  const configurationError = providerConfigurationError(config);
  if (configurationError) throw new Error(configurationError);

  const poolManager = KeyPoolManager.getInstance();

  // Automatically register configured keys in KeyPoolManager
  for (const p of PROVIDERS) {
    const keys = extractConfiguredKeys(config, p);
    if (keys.length > 0) {
      poolManager.registerKeys(p, keys);
    }
  }

  const primaryKeys = extractConfiguredKeys(config, config.provider);
  const hasMultipleKeys = primaryKeys.length > 1;
  const isFallbackMeshEnabled = Boolean(
    config.fallbackMesh || (config as any).enableFallbackMesh || config.fallbackProviders?.length,
  );

  // If multiple keys are configured or fallback mesh is enabled, wrap with FallbackMeshProvider
  if (hasMultipleKeys || isFallbackMeshEnabled) {
    const providersMap = new Map<string, LLMProvider>();

    for (const p of PROVIDERS) {
      const keys = extractConfiguredKeys(config, p);
      if (keys.length > 0 || p === "ollama") {
        let pProvider: LLMProvider;
        if (keys.length > 1) {
          pProvider = new KeyPoolProvider(p, (k) => createBaseProvider(p, k, config), {
            keyPool: poolManager,
            maxRetries: config.errorRetries,
          });
        } else {
          pProvider = createBaseProvider(p, keys[0] ?? "", config);
        }
        providersMap.set(p, new RetryProvider(pProvider, config.errorRetries));
      }
    }

    return new FallbackMeshProvider({
      primaryProvider: config.provider,
      providers: providersMap,
      fallbackOrder: config.fallbackOrder ?? config.fallbackProviders ?? DEFAULT_FALLBACK_ORDER,
      maxFallbacks: config.maxFallbacks,
    });
  }

  // Preserve existing single-key behavior for backward compatibility
  let provider: LLMProvider;
  switch (config.provider) {
    case "anthropic": {
      const key = required(config.anthropicApiKey, "Anthropic API key");
      provider = new AnthropicProvider(key);
      break;
    }
    case "openai": {
      const key = required(config.openaiApiKey, "OpenAI API key");
      provider = new OpenAIProvider(key, config.openaiApi ?? "responses", {
        baseURL: config.openaiBaseURL,
        defaultHeaders: config.openaiHeaders,
      });
      break;
    }
    case "openrouter": {
      const key = required(config.openrouterApiKey, "OpenRouter API key");
      provider = new OpenRouterProvider(key);
      break;
    }
    case "nvidia": {
      const key = required(config.nvidiaApiKey, "NVIDIA API key");
      provider = new NvidiaProvider(key);
      break;
    }
    case "deepseek": {
      const key = required(config.deepseekApiKey, "DeepSeek API key");
      provider = new DeepSeekProvider(key);
      break;
    }
    case "ollama": {
      const baseURL =
        config.ollamaEndpoint ??
        `http://${config.ollamaHost ?? "localhost"}:${config.ollamaPort ?? 11434}`;
      provider = new OllamaProvider(baseURL, config.ollamaApiKey);
      break;
    }
    case "gemini": {
      const key = required(config.geminiApiKey, "Gemini API key");
      provider = new GeminiProvider(key);
      break;
    }
    case "groq": {
      const key = required(config.groqApiKey, "Groq API key");
      provider = new GroqProvider(key);
      break;
    }
    case "vertex-ai": {
      const credentialsPath = required(config.vertexAICredentialsPath, "Vertex AI credentials path");
      provider = new VertexAIProvider(credentialsPath, config.vertexAILocation);
      break;
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }

  return new RetryProvider(provider, config.errorRetries);
}
