import { OpenAIProvider, type OpenAIApiMode } from "./openai.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Completion-token ceiling per model. Groq rejects a request outright when
 * max_completion_tokens exceeds the model's limit, and the limits vary by two
 * orders of magnitude (512 to 131072), so guessing is not an option.
 *
 * Generated from the live catalogue — regenerate after Groq adds models with:
 *   curl -s https://api.groq.com/openai/v1/models \
 *     -H "Authorization: Bearer $GROQ_API_KEY" \
 *     | jq -r '.data[] | "  \"\(.id)\": \(.max_completion_tokens),"' | sort
 */
const MAX_OUTPUT_TOKENS: Record<string, number> = {
  "allam-2-7b": 4096,
  "canopylabs/orpheus-arabic-saudi": 50000,
  "canopylabs/orpheus-v1-english": 50000,
  "groq/compound": 8192,
  "groq/compound-mini": 8192,
  "llama-3.1-8b-instant": 131072,
  "llama-3.3-70b-versatile": 32768,
  "meta-llama/llama-prompt-guard-2-22m": 512,
  "meta-llama/llama-prompt-guard-2-86m": 512,
  "openai/gpt-oss-120b": 65536,
  "openai/gpt-oss-20b": 65536,
  "openai/gpt-oss-safeguard-20b": 65536,
  "qwen/qwen3.6-27b": 16384,
  "whisper-large-v3": 448,
  "whisper-large-v3-turbo": 448,
};

/**
 * Applied to models missing from the table above. Deliberately low: an
 * unlisted model that actually allows more only loses output length, whereas
 * overshooting its real limit fails the request outright. allam-2-7b caps at
 * 4096, so anything higher would not be a safe default for a new small model.
 */
const FALLBACK_MAX_OUTPUT = 4096;

export class GroqProvider extends OpenAIProvider {
  constructor(apiKey: string, apiMode: OpenAIApiMode = "responses") {
    super(apiKey, apiMode, GROQ_BASE_URL, "groq");
  }

  protected override maxOutputCap(model: string): number {
    return MAX_OUTPUT_TOKENS[model.toLowerCase()] ?? FALLBACK_MAX_OUTPUT;
  }
}
