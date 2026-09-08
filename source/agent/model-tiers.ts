import type { ProviderName } from "../config/startup.js";
import { classifyHeuristic, classifyWithModel, type TaskClassification } from "./task-classifier.js";

/**
 * Per-provider model tiers. Single source of truth for both the manual `/fast`
 * and `/deep` commands and the automatic internal-call router below.
 *
 * Ollama is intentionally absent: its models are whatever the user has pulled
 * locally, so a static table cannot name one — callers fall back to the current
 * model in that case.
 */
export const FAST_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  openrouter: "~google/gemini-flash-latest",
  nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
  gemini: "gemini-3.5-flash-lite",
  "vertex-ai": "vertex/gemini-3.5-flash-lite",
};

export const DEEP_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "~anthropic/claude-sonnet-latest",
  nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
  gemini: "gemini-3.5-pro",
  "vertex-ai": "vertex/gemini-3.5-pro",
};

/**
 * Resolve the cheap model to use for internal, correctness-tolerant calls
 * (conversation summarization, classification). Falls back to the caller's
 * current model when the provider has no known fast tier (e.g. Ollama), so the
 * call always succeeds — it just isn't cheaper.
 */
export function resolveFastModel(
  provider: ProviderName,
  currentModel: string,
): string {
  return FAST_MODELS[provider] ?? currentModel;
}

/**
 * True when routing an internal call to the fast model would actually change
 * models — lets callers avoid logging/telemetry noise when it's a no-op.
 */
export function wouldRouteToFast(
  provider: ProviderName,
  currentModel: string,
): boolean {
  const fast = FAST_MODELS[provider];
  return fast !== undefined && fast !== currentModel;
}

/**
 * Decide which model to use for a user turn, optionally routing confidently-
 * simple turns to the cheap tier. Opt-in and conservative: unless routing is
 * enabled AND the turn is classified simple with high confidence, the caller's
 * configured model is returned unchanged. Misrouting a hard task is far more
 * costly than paying full price for a simple one, so the bar for downgrading
 * is deliberately high.
 */
interface TurnRouteOptions {
  provider: ProviderName;
  currentModel: string;
  text: string;
  enabled: boolean;
  /** Minimum confidence required to downgrade to the fast model. */
  minConfidence?: number;
}

interface TurnRoute {
  model: string;
  classification: TaskClassification;
  routed: boolean;
}

/** Shared decision: given a classification, decide whether to downgrade. */
function decideTurnRoute(
  options: TurnRouteOptions,
  classification: TaskClassification,
): TurnRoute {
  const { provider, currentModel, enabled } = options;
  const minConfidence = options.minConfidence ?? 0.85;
  if (!enabled) return { model: currentModel, classification, routed: false };

  const fast = FAST_MODELS[provider];
  const canDowngrade =
    classification.difficulty === "simple" &&
    classification.confidence >= minConfidence &&
    fast !== undefined &&
    fast !== currentModel;

  if (!canDowngrade) return { model: currentModel, classification, routed: false };
  return { model: fast!, classification, routed: true };
}

/**
 * Synchronous turn routing using the dependency-free heuristic classifier.
 * Opt-in and conservative: unless routing is enabled AND the turn is classified
 * simple with high confidence, the configured model is returned unchanged.
 */
export function resolveTurnModel(options: TurnRouteOptions): TurnRoute {
  return decideTurnRoute(options, classifyHeuristic(options.text));
}

/**
 * Async turn routing using the pure-TS trained model (with the heuristic as a
 * safety gate). Same conservative decision as the sync version, but with the
 * model's more accurate simple/hard call. Falls back to the heuristic if the
 * model is unavailable.
 */
export async function resolveTurnModelAsync(options: TurnRouteOptions): Promise<TurnRoute> {
  const classification = await classifyWithModel(options.text);
  return decideTurnRoute(options, classification);
}
