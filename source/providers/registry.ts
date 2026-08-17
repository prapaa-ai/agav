import type { LLMProvider } from "./types.js";
import type { AgavConfig } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { GeminiProvider } from "./gemini.js";
import { VertexAIProvider } from "./vertex-ai.js";
import { RetryProvider } from "./retry.js";
import { agavHomePath } from "../utils/shell-hints.js";

export function createProvider(config: AgavConfig): LLMProvider {
  let provider: LLMProvider;

  switch (config.provider) {
    case "anthropic": {
      const key = config.anthropicApiKey;
      if (!key) {
        throw new Error(
          `Anthropic API key not found. Set ANTHROPIC_API_KEY or add it to ${agavHomePath("config.json")}`,
        );
      }
      provider = new AnthropicProvider(key);
      break;
    }
    case "openai": {
      const key = config.openaiApiKey;
      if (!key) {
        throw new Error(
          `OpenAI API key not found. Set OPENAI_API_KEY or add it to ${agavHomePath("config.json")}`,
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
          `Gemini API key not found. Set GEMINI_API_KEY or add it to ${agavHomePath("config.json")}`,
        );
      }
      provider = new GeminiProvider(key);
      break;
    }
    case "vertex-ai": {
      if (!config.AGAV_USE_VERTEX_AI) {
        throw new Error(
          `Vertex AI is not enabled. Set AGAV_USE_VERTEX_AI=true or add it to ${agavHomePath("config.json")}`,
        );
      }
      if (!config.VERTEX_AI_CREDENTIALS_PATH) {
        throw new Error(
          `Vertex AI credentials path not found. Set VERTEX_AI_CREDENTIALS_PATH or add it to ${agavHomePath("config.json")}`,
        );
      }
      provider = new VertexAIProvider(config.VERTEX_AI_CREDENTIALS_PATH);
      break;
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }

  return new RetryProvider(provider, config.errorRetries);
}
