import type { AgavConfig, EffortLevel } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";
import { FAST_MODELS, DEEP_MODELS } from "../commands/model-routing.js";

export type ModelTier = "fast" | "deep";

export interface ModelSuggestion {
  tier: ModelTier;
  model: string;
  reason: string;
  /** Effort that pairs with the tier: low for fast work, high for deep work. */
  effort: EffortLevel;
  /** "ai" when the classifier answered, "heuristic" when it fell back. */
  source: "ai" | "heuristic";
}

const CLASSIFIER_TIMEOUT_MS = 8000;

const CLASSIFIER_PROMPT =
  "You route a coding assistant's request to a model tier. " +
  "Reply with exactly one line: `fast: <reason>` or `deep: <reason>`, reason under 12 words. " +
  "Choose fast for quick questions, lookups, small edits, explanations of a single snippet. " +
  "Choose deep for multi-file changes, refactors, debugging, architecture, planning, or anything ambiguous and large.";

const DEEP_HINTS = /\b(refactor|architect|design|debug|investigate|migrat|implement|rewrite|optimi[sz]e|feature|across|entire|whole|codebase|plan|security|race condition|performance)\w*/i;

/** Parse the classifier's one-line reply; returns null when it is not in the expected shape. */
export function parseClassifierReply(text: string): { tier: ModelTier; reason: string } | null {
  const match = /\b(fast|deep)\b\s*[:\-–—]?\s*(.*)/i.exec(text.trim());
  if (!match) return null;
  const tier = match[1]!.toLowerCase() as ModelTier;
  const reason = (match[2] ?? "").split("\n")[0]!.trim().replace(/^[`"']|[`"'.]$/g, "");
  return { tier, reason: reason || (tier === "fast" ? "Simple request" : "Complex request") };
}

/** Keyword/length fallback used when the classifier is unavailable or unparseable. */
export function heuristicTier(prompt: string): { tier: ModelTier; reason: string } {
  if (DEEP_HINTS.test(prompt)) return { tier: "deep", reason: "Request looks like multi-step engineering work" };
  if (prompt.length > 400) return { tier: "deep", reason: "Long, detailed request" };
  return { tier: "fast", reason: "Short, focused request" };
}

export const EFFORT_FOR_TIER: Record<ModelTier, EffortLevel> = { fast: "low", deep: "high" };

/** Whether an AI model suggestion can be offered at all for this config. */
export function canSuggestModel(config: AgavConfig): boolean {
  if (config.modelSuggestions === false) return false;
  // An org pin leaves nothing to choose.
  if (config.orgManagedModel !== undefined) return false;
  return Boolean(FAST_MODELS[config.provider] && DEEP_MODELS[config.provider]);
}

/**
 * Ask the provider's fast model which tier suits the prompt, falling back to a
 * local heuristic on timeout, error, or an unparseable reply. Returns null when
 * suggestions are unavailable for this provider.
 */
export async function suggestModel(
  provider: LLMProvider,
  config: AgavConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<ModelSuggestion | null> {
  if (!canSuggestModel(config)) return null;
  const fastModel = FAST_MODELS[config.provider]!;
  const modelFor = (tier: ModelTier) => (tier === "fast" ? fastModel : DEEP_MODELS[config.provider]!);

  const timeout = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let text = "";
  try {
    for await (const event of provider.stream({
      model: fastModel,
      messages: [{ role: "user", content: [{ type: "text", text: prompt.slice(0, 4000) }] }],
      systemPrompt: CLASSIFIER_PROMPT,
      effort: "minimal",
      maxTokens: 60,
      signal: combined,
    })) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") throw event.error;
    }
  } catch {
    if (signal?.aborted) return null;
    text = "";
  }

  const parsed = parseClassifierReply(text);
  const { tier, reason } = parsed ?? heuristicTier(prompt);
  return { tier, model: modelFor(tier), reason, effort: EFFORT_FOR_TIER[tier], source: parsed ? "ai" : "heuristic" };
}
