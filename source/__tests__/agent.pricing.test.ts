import { describe, expect, it } from "vitest";

import { lookupRate, estimateCost, formatUsd } from "../agent/pricing.js";
import type { TokenUsage } from "../commands/types.js";

const usage = (u: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...u,
});

describe("pricing", () => {
  it("matches known model families", () => {
    expect(lookupRate("claude-sonnet-4-20250514")).toEqual({ input: 3, output: 15 });
    expect(lookupRate("claude-haiku-4-5-20251001")).toEqual({ input: 0.8, output: 4 });
    expect(lookupRate("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
  });

  it("returns null for an unknown model", () => {
    expect(lookupRate("some-local-llama")).toBeNull();
  });

  it("estimateCost reports known:false for unknown models", () => {
    const e = estimateCost(usage({ inputTokens: 1000 }), "some-local-llama");
    expect(e.known).toBe(false);
    expect(e.total).toBe(0);
  });

  it("computes input and output cost at the model rate", () => {
    // 1M input + 1M output on Sonnet = $3 + $15 = $18.
    const e = estimateCost(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), "claude-sonnet-4");
    expect(e.breakdown.input).toBeCloseTo(3, 6);
    expect(e.breakdown.output).toBeCloseTo(15, 6);
    expect(e.total).toBeCloseTo(18, 6);
  });

  it("bills cache reads at 0.1x input and reports the saving", () => {
    // 1M cache-read tokens on Sonnet: 0.1 * $3 = $0.30 charged; $3 without cache.
    const e = estimateCost(usage({ cacheReadTokens: 1_000_000 }), "claude-sonnet-4");
    expect(e.breakdown.cacheRead).toBeCloseTo(0.3, 6);
    expect(e.withoutCache).toBeCloseTo(3, 6);
    expect(e.cacheSavings).toBeCloseTo(2.7, 6);
  });

  it("bills cache writes at 1.25x input", () => {
    const e = estimateCost(usage({ cacheWriteTokens: 1_000_000 }), "claude-sonnet-4");
    expect(e.breakdown.cacheWrite).toBeCloseTo(3.75, 6);
  });

  it("formats USD with sensible precision", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0001234)).toBe("$0.0001");
    expect(formatUsd(0.123)).toBe("$0.123");
    expect(formatUsd(12.5)).toBe("$12.50");
  });
});
