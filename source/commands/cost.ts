import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { estimateCost, formatUsd } from "../agent/pricing.js";

/** Handles the /cost command — session token usage and estimated spend. */
export const costCommand: SlashCommand = {
  name: "cost",
  description: "Show session token usage, estimated cost, and cache savings",
  usage:
    "Usage: /cost\n\nShows this session's token usage (input, output, cache read/write), " +
    "an estimated dollar cost for the current model, and how much prompt caching saved. " +
    "Costs are approximate — providers change prices and Agav has no live price feed.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const usage = context.getDebugState().tokenUsage;
    const model = context.config.model;
    const est = estimateCost(usage, model);

    const totalTokens =
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

    const lines: string[] = [];
    lines.push("\x1b[1mSession cost\x1b[0m");
    lines.push("");
    lines.push(`Model: ${model}`);
    lines.push("");
    lines.push("Tokens:");
    lines.push(`  input:        ${usage.inputTokens.toLocaleString()}`);
    lines.push(`  output:       ${usage.outputTokens.toLocaleString()}`);
    lines.push(`  cache read:   ${usage.cacheReadTokens.toLocaleString()}`);
    lines.push(`  cache write:  ${usage.cacheWriteTokens.toLocaleString()}`);
    lines.push(`  total:        ${totalTokens.toLocaleString()}`);

    // Cache hit rate: how much of the "input side" was served from cache.
    const inputSide = usage.inputTokens + usage.cacheReadTokens;
    if (inputSide > 0) {
      const hitRate = Math.round((usage.cacheReadTokens / inputSide) * 100);
      lines.push("");
      lines.push(`Cache hit rate (input side): ${hitRate}%`);
    }

    lines.push("");
    if (!est.known) {
      lines.push("\x1b[2mNo price table entry for this model — cost estimate unavailable.\x1b[0m");
      return { type: "message", text: lines.join("\n") };
    }

    lines.push("Estimated cost \x1b[2m(approximate)\x1b[0m:");
    lines.push(`  input:        ${formatUsd(est.breakdown.input)}`);
    lines.push(`  output:       ${formatUsd(est.breakdown.output)}`);
    lines.push(`  cache read:   ${formatUsd(est.breakdown.cacheRead)}`);
    lines.push(`  cache write:  ${formatUsd(est.breakdown.cacheWrite)}`);
    lines.push(`  \x1b[1mtotal:        ${formatUsd(est.total)}\x1b[0m`);

    if (est.cacheSavings > 0) {
      const pct = est.withoutCache > 0 ? Math.round((est.cacheSavings / est.withoutCache) * 100) : 0;
      lines.push("");
      lines.push(
        `\x1b[32mPrompt caching saved ~${formatUsd(est.cacheSavings)} (${pct}%) vs. no cache.\x1b[0m`,
      );
    }

    return { type: "message", text: lines.join("\n") };
  },
};
