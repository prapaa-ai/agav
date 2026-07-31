import type { LLMProvider } from "./types.js";
import type { AgavConfig } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { GeminiProvider } from "./gemini.js";
import { RetryProvider } from "./retry.js";

export function createProvider(config: AgavConfig): LLMProvider {
  let provider: LLMProvider;

  switch (config.provider) {
    case "anthropic": {
      const key = config.anthropicApiKey;
      if (!key) {
        throw new Error(
          "Anthropic API key not found. Set ANTHROPIC_API_KEY or add it to ~/.agav/config.json",
        );
      }
      provider = new AnthropicProvider(key);
      break;
    }
    case "openai": {
      const key = config.openaiApiKey;
      if (!key) {
        throw new Error(
          "OpenAI API key not found. Set OPENAI_API_KEY or add it to ~/.agav/config.json",
        );
      }
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
      const key = config.geminiApiKey;
      if (!key) {
        throw new Error(
          "Gemini API key not found. Set GEMINI_API_KEY or add it to ~/.agav/config.json",
        );
      }
      provider = new GeminiProvider(key);
      break;
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }

  return new RetryProvider(provider, config.errorRetries);
}
