import type { TokenUsage } from "../commands/types.js";

/**
 * Rough per-model token pricing for cost *estimation* in the `/cost` command.
 * Rates are USD per 1M tokens and are approximate — providers change prices and
 * Agav has no live price feed — so the figure is clearly labeled an estimate.
 *
 * Cache reads are billed at ~10% of input on Anthropic and OpenAI-family; cache
 * writes at ~1.25× input on Anthropic. We model those as multipliers of the
 * matched input rate so a missing exact number still gives a sane estimate.
 */
export interface ModelRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/** Matched by substring against the lowercased model id, first match wins. */
const RATE_TABLE: Array<{ match: RegExp; rate: ModelRate }> = [
  // Anthropic
  { match: /claude.*opus/, rate: { input: 15, output: 75 } },
  { match: /claude.*sonnet/, rate: { input: 3, output: 15 } },
  { match: /claude.*haiku/, rate: { input: 0.8, output: 4 } },
  // OpenAI
  { match: /gpt-4o-mini|gpt-5.*mini|gpt-4\.1-mini/, rate: { input: 0.15, output: 0.6 } },
  { match: /gpt-4o|gpt-4\.1|gpt-5/, rate: { input: 2.5, output: 10 } },
  { match: /gpt-4/, rate: { input: 10, output: 30 } },
  // Gemini
  { match: /gemini.*flash/, rate: { input: 0.1, output: 0.4 } },
  { match: /gemini.*pro|gemini/, rate: { input: 1.25, output: 5 } },
];

/** Cache-read discount and cache-write premium, as multipliers of input rate. */
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

/** Look up an approximate rate for a model id, or null if unknown. */
export function lookupRate(model: string): ModelRate | null {
  const m = model.toLowerCase();
  for (const entry of RATE_TABLE) {
    if (entry.match.test(m)) return entry.rate;
  }
  return null;
}

export interface CostEstimate {
  /** Total estimated USD for the session. */
  total: number;
  /** Breakdown by category. */
  breakdown: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** What the input+cache tokens would have cost at the full input rate — i.e.
   * the counterfactual with no caching — so we can show the saving. */
  withoutCache: number;
  /** Estimated USD saved by cache reads paying 0.1× instead of 1×. */
  cacheSavings: number;
  /** Whether a rate was found for the model. */
  known: boolean;
}

/**
 * Estimate session cost from token usage and the model id. When the model is
 * unknown, returns zeros with `known: false` so the caller can say so.
 */
export function estimateCost(usage: TokenUsage, model: string): CostEstimate {
  const rate = lookupRate(model);
  const zero: CostEstimate = {
    total: 0,
    breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    withoutCache: 0,
    cacheSavings: 0,
    known: rate !== null,
  };
  if (!rate) return zero;

  const perInput = rate.input / 1_000_000;
  const perOutput = rate.output / 1_000_000;

  const input = usage.inputTokens * perInput;
  const output = usage.outputTokens * perOutput;
  const cacheRead = usage.cacheReadTokens * perInput * CACHE_READ_MULT;
  const cacheWrite = usage.cacheWriteTokens * perInput * CACHE_WRITE_MULT;

  const total = input + output + cacheRead + cacheWrite;

  // Counterfactual: cache-read tokens billed at full input price, and cache
  // writes billed at plain input price (no premium).
  const withoutCache =
    input +
    output +
    usage.cacheReadTokens * perInput +
    usage.cacheWriteTokens * perInput;

  return {
    total,
    breakdown: { input, output, cacheRead, cacheWrite },
    withoutCache,
    cacheSavings: Math.max(0, withoutCache - total),
    known: true,
  };
}

/** Format a USD amount with sensible precision for small figures. */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}
