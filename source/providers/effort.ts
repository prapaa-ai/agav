import type { EffortLevel } from "../config/config.js";

const EFFORT_PROMPTS: Partial<Record<EffortLevel, string>> = {
  low: "Be concise. Answer directly. Skip analysis unless asked.",
  high: "Think carefully. Consider edge cases. Verify your reasoning.",
  max: "Be exhaustive. Consider multiple approaches. Verify all claims.",
};

const OLLAMA_EFFORT_PROMPTS: Partial<Record<EffortLevel, string>> = {
  low: EFFORT_PROMPTS.low,
  high:
    "Think carefully before answering. Break complex problems into clear steps, inspect all relevant context, consider edge cases and likely failure modes, and verify the result. Keep the final response focused and practical.",
  max:
    "Use maximum reasoning effort. Analyze the problem from multiple angles, compare viable approaches and their tradeoffs, inspect all relevant context, test your assumptions, trace edge cases and failure modes, and verify every important claim or result before answering. Be exhaustive in your reasoning and organize the final response clearly.",
};

export type OpenAIEffortLevel = "low" | "medium" | "high" | "xhigh";

const OPENAI_EFFORT_LEVELS: Record<EffortLevel, OpenAIEffortLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

/** Translate Agav's provider-neutral levels to OpenAI's reasoning_effort enum. */
export function mapOpenAIEffort(effort: EffortLevel): OpenAIEffortLevel {
  return OPENAI_EFFORT_LEVELS[effort];
}

/** Models known to accept their provider's native effort request parameter. */
export function supportsNativeEffort(provider: string, model: string): boolean {
  const normalized = model.toLowerCase();

  if (provider === "openrouter") {
    // OpenRouter spans model families with incompatible effort parameters.
    // Fall back to prompt steering rather than sending reasoning_effort blindly.
    return false;
  }

  if (provider === "openai") {
    return /^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(normalized)
      || normalized.includes("codex");
  }

  if (provider === "anthropic") {
    // Anthropic added effort controls to the newer 4.5+ model generation.
    return /^claude-(?:opus|sonnet)-4-[5-9](?:[-@]|$)/.test(normalized)
      || /^claude-(?:fable|mythos)-5(?:[-@]|$)/.test(normalized);
  }

  if (provider === "gemini" || provider === "vertex-ai") {
    return /^(?:google\/)?gemini-[23]\.5/.test(normalized);
  }

  return false;
}

/** Whether Chat Completions accepts reasoning_effort alongside function tools. */
export function supportsOpenAIChatToolEffort(model: string): boolean {
  const normalized = model.toLowerCase();
  // GPT-5.4 mini supports each feature separately, but rejects their combination
  // on /v1/chat/completions. Snapshots use the same model-name prefix.
  return !/^gpt-5\.4-mini(?:-|$)/.test(normalized);
}

/** Prepend behavioral guidance when a model has no native reasoning control. */
export function applyEffortPrompt(systemPrompt: string | undefined, effort: EffortLevel): string | undefined {
  const prefix = EFFORT_PROMPTS[effort];
  if (!prefix) return systemPrompt;
  return systemPrompt ? `${prefix}\n\n${systemPrompt}` : prefix;
}

const GEMINI_THINKING_BUDGETS: Record<EffortLevel, number> = {
  low: 0,
  medium: 1024,
  high: 8192,
  max: 24576,
};

/** Translate Agav effort to Gemini's thinkingConfig thinkingBudget. */
export function mapGeminiThinkingBudget(effort: EffortLevel): number {
  return GEMINI_THINKING_BUDGETS[effort];
}

/** Add more explicit reasoning guidance for local models without native effort controls. */
export function applyOllamaEffortPrompt(systemPrompt: string | undefined, effort: EffortLevel): string | undefined {
  const prefix = OLLAMA_EFFORT_PROMPTS[effort];
  if (!prefix) return systemPrompt;
  return systemPrompt ? `${prefix}\n\n${systemPrompt}` : prefix;
}
