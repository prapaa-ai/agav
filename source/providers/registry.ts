import type { LLMProvider } from "./types.js";
import type { AgavConfig } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { OllamaProvider } from "./ollama.js";
import { GeminiProvider } from "./gemini.js";
import { VertexAIProvider } from "./vertex-ai.js";
import { RetryProvider } from "./retry.js";
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

export function createProvider(config: AgavConfig): LLMProvider {
  const configurationError = providerConfigurationError(config);
  if (configurationError) throw new Error(configurationError);

  let provider: LLMProvider;

  switch (config.provider) {
    case "anthropic": {
      const key = required(config.anthropicApiKey, "Anthropic API key");
      provider = new AnthropicProvider(key);
      break;
    }
    case "openai": {
      const key = required(config.openaiApiKey, "OpenAI API key");
      provider = new OpenAIProvider(key, config.openaiApi ?? "responses");
      break;
    }
    case "openrouter": {
      const key = required(config.openrouterApiKey, "OpenRouter API key");
      provider = new OpenRouterProvider(key);
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
