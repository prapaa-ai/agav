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
import { RetryProvider } from "./retry.js";
import { KeyPoolManager } from "./key-pool.js";
import { KeyPoolProvider } from "./key-pool-provider.js";
import { providerConfigurationError } from "../config/startup.js";

/**
 * `providerConfigurationError` has already rejected a config that is missing
 * the credential for its provider, so these should never fire — but a plain
 * check beats a non-null assertion that silently hands `undefined` to a
 * provider constructor if the two ever drift apart.
 */
function required(value: string | undefined, description: string): string {
  if (!value) throw new Error(`${description} is missing from the resolved configuration`);
  return value;
}

function getProviderKeys(single?: string, multiple?: string[]): string[] {
  if (multiple && multiple.length > 0) {
    return multiple;
  }
  if (single) {
    return [single];
  }
  return [];
}

import {
  FallbackMeshProvider,
  createSingleProvider,
  getProviderKeysFor,
  isProviderConfigured,
} from "./fallback-mesh.js";

/**
 * Registers all configured credentials across all supported providers into KeyPoolManager.
 */
export function registerAllConfiguredKeys(config: AgavConfig): void {
  const keyPool = KeyPoolManager.getInstance();
  const providerList: Array<{ provider: string; single?: string; multiple?: string[] }> = [
    { provider: "anthropic", single: config.anthropicApiKey, multiple: config.anthropicApiKeys },
    { provider: "openai", single: config.openaiApiKey, multiple: config.openaiApiKeys },
    { provider: "openrouter", single: config.openrouterApiKey, multiple: config.openrouterApiKeys },
    { provider: "nvidia", single: config.nvidiaApiKey, multiple: config.nvidiaApiKeys },
    { provider: "deepseek", single: config.deepseekApiKey, multiple: config.deepseekApiKeys },
    { provider: "gemini", single: config.geminiApiKey, multiple: config.geminiApiKeys },
    { provider: "groq", single: config.groqApiKey, multiple: config.groqApiKeys },
  ];

  for (const item of providerList) {
    const keys = getProviderKeys(item.single, item.multiple);
    if (keys.length > 0) {
      keyPool.registerKeys(item.provider, keys);
    }
  }
}

export function hasOtherConfiguredProviders(primary: string, config: AgavConfig): boolean {
  const normPrimary = primary.trim().toLowerCase();
  const others = ["groq", "nvidia", "gemini", "openrouter", "deepseek", "openai", "anthropic", "ollama"].filter(
    (p) => p !== normPrimary,
  );
  return others.some((p) => isProviderConfigured(p, config));
}

export function createProvider(config: AgavConfig): LLMProvider {
  const configurationError = providerConfigurationError(config);
  if (configurationError) throw new Error(configurationError);

  registerAllConfiguredKeys(config);

  const primaryKeys = getProviderKeysFor(config.provider, config);
  const hasOther = hasOtherConfiguredProviders(config.provider, config);

  let provider: LLMProvider;
  if (primaryKeys.length > 1 || hasOther) {
    provider = new FallbackMeshProvider(config);
  } else {
    // When only a single key is configured for a single provider
    const key = primaryKeys[0] ?? "";
    provider = createSingleProvider(config.provider, key, config);
  }

  return new RetryProvider(provider, config.errorRetries);
}
