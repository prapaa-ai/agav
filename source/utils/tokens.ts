import type { Message } from "../providers/types.js";

export function estimateTokens(text: string): number {
  if (!text) return 0;

  // BPE-aware estimation:
  // - Common English words: ~1.3 tokens per word
  // - Code/symbols: ~1 token per 3 chars
  // - Whitespace is mostly free (merged with adjacent tokens)
  // - JSON/structured text: ~1 token per 3-4 chars

  // Count words and non-word segments separately
  const words = text.match(/\b\w+\b/g)?.length ?? 0;
  const nonWordChars = text.replace(/\b\w+\b/g, "").length;

  // ~1.3 tokens per word + ~1 token per 3 non-word chars + overhead
  return Math.ceil(words * 1.3 + nonWordChars / 3);
}

export function estimateMessageTokens(message: Message): number {
  let total = 4; // message overhead (role, formatting)
  for (const block of message.content) {
    if (block.text) total += estimateTokens(block.text);
    if (block.toolResult && !block.toolResultContent) total += estimateTokens(block.toolResult);
    if (block.toolInput) total += estimateTokens(JSON.stringify(block.toolInput));
    if (block.toolName) total += estimateTokens(block.toolName) + 2;
    if (block.toolCallId) total += 3;
    if (block.imageData) total += Math.ceil(block.imageData.length / 1.5 / 750); // ~750 tokens per image tile
    if (block.toolResultContent) {
      total += estimateMessageTokens({ role: "user", content: block.toolResultContent });
    }
  }
  return total;
}

export function estimateConversationTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

export interface ContextLimits {
  maxTokens: number;
  warningThreshold: number;
}

/**
 * Resolve the usable context window for a model.
 *
 * `explicitMax` wins over the name-based table below. Providers that know their
 * real window at runtime — Ollama reads it from /api/show and clamps it — must
 * pass it, otherwise the table's fallback silently over-estimates and the
 * conversation is left to grow past what the provider will actually accept.
 */
export function getContextLimits(model: string, explicitMax?: number): ContextLimits {
  if (explicitMax !== undefined && explicitMax > 0) {
    return { maxTokens: explicitMax, warningThreshold: Math.floor(explicitMax * 0.8) };
  }

  const m = model.toLowerCase();

  // GPT-5.4-mini: 400k context
  if (m.includes("gpt-5") && m.includes("mini")) {
    return { maxTokens: 400_000, warningThreshold: 320_000 };
  }
  // GPT-5.x (non-mini), GPT-4.1, GPT-4.1-mini: ~1M context
  if (m.includes("gpt-5") || m.includes("gpt-4.1")) {
    return { maxTokens: 1_000_000, warningThreshold: 800_000 };
  }
  // GPT-4o: 128k context
  if (m.includes("gpt-4o")) {
    return { maxTokens: 128_000, warningThreshold: 100_000 };
  }
  // GPT-4 (non-4o, non-4.1): 128k context
  if (m.includes("gpt-4")) {
    return { maxTokens: 128_000, warningThreshold: 100_000 };
  }
  // Claude Opus 4.6+, Sonnet 4.6+, Sonnet 5, Opus 5, Fable 5: 1M context
  if (m.includes("opus") || m.includes("fable") || m.includes("sonnet")) {
    if (m.includes("4-5") || m.includes("4.5")) {
      return { maxTokens: 200_000, warningThreshold: 160_000 };
    }
    return { maxTokens: 1_000_000, warningThreshold: 800_000 };
  }
  // Claude Haiku 4.5: 200k context
  if (m.includes("haiku")) {
    return { maxTokens: 200_000, warningThreshold: 160_000 };
  }
  // Gemini models: default to 1M
  if (m.includes("gemini")) {
    return { maxTokens: 1_000_000, warningThreshold: 800_000 };
  }
  return { maxTokens: 128_000, warningThreshold: 100_000 };
}
