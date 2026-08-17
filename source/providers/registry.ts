import type { LLMProvider } from "./types.js";
import type { AgavConfig } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { GeminiProvider } from "./gemini.js";
import { VertexAIProvider } from "./vertex-ai.js";
import { RetryProvider } from "./retry.js";
import { providerConfigurationError } from "../config/startup.js";

export function createProvider(config: AgavConfig): LLMProvider {
  const configurationError = providerConfigurationError(config);
  if (configurationError) throw new Error(configurationError);

  let provider: LLMProvider;

  switch (config.provider) {
    case "anthropic": {
      const key = config.anthropicApiKey!;
      provider = new AnthropicProvider(key);
      break;
    }
    case "openai": {
      const key = config.openaiApiKey!;
      provider = new OpenAIProvider(key, config.openaiApi ?? "responses");
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
      const key = config.geminiApiKey!;
      provider = new GeminiProvider(key);
      break;
    }
    case "vertex-ai": {
      provider = new VertexAIProvider(config.VERTEX_AI_CREDENTIALS_PATH!);
      break;
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }

  return new RetryProvider(provider, config.errorRetries);
}
