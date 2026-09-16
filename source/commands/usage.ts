import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { KeyPoolManager } from "../providers/key-pool.js";
import { getContextLimits } from "../utils/tokens.js";
import { maskApiKey } from "../config/keys-interactive.js";
import { getFallbackChain } from "../providers/fallback-mesh.js";

/** Formats integer with comma separators for clean readability. */
export function formatNumber(num: number): string {
  return (num ?? 0).toLocaleString("en-US");
}

/** Renders a visual ASCII progress bar. */
export function renderProgressBar(percentage: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, isNaN(percentage) ? 0 : percentage));
  const filledLength = Math.round((clamped / 100) * width);
  const emptyLength = width - filledLength;
  return `[${"█".repeat(filledLength)}${"░".repeat(emptyLength)}] ${clamped.toFixed(1)}%`;
}

export interface SessionUsageData {
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
  contextWindow: {
    model: string;
    conversationTokens: number;
    maxTokens: number;
    saturationPercentage: number;
    messageCount: number;
    wasCompacted: boolean;
  };
  keyPools: Record<
    string,
    {
      totalKeys: number;
      healthyKeys: number;
      isCooling: boolean;
      soonestCooldownSec: number;
      slots: Array<{
        index: number;
        maskedKey: string;
        isCooling: boolean;
        cooldownRemainingSec: number;
        activeRequests: number;
        totalRequests: number;
        errorCount: number;
      }>;
    }
  >;
  fallbackChain: {
    primaryProvider: string;
    activeProvider: string;
    chain: Array<{
      provider: string;
      status: "READY" | "COOLING" | "EMPTY";
      totalKeys: number;
      healthyKeys: number;
      cooldownSec: number;
    }>;
  };
}

export function collectUsageData(context: CommandContext): SessionUsageData {
  const debugState = context.getDebugState ? context.getDebugState() : null;
  const tokenUsage = debugState?.tokenUsage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  const totalTokens =
    tokenUsage.inputTokens +
    tokenUsage.outputTokens +
    (tokenUsage.cacheReadTokens ?? 0) +
    (tokenUsage.cacheWriteTokens ?? 0);

  const conversation = context.conversation;
  const conversationTokens = conversation ? conversation.tokenCount : 0;
  const messageCount = conversation ? conversation.length : 0;
  const wasCompacted = conversation ? conversation.wasCompacted : false;

  const activeModel = context.config.model;
  const limits = getContextLimits(
    activeModel,
    conversation?.getContextWindow ? conversation.getContextWindow() : undefined,
  );
  const maxTokens = limits.maxTokens;
  const saturationPercentage =
    maxTokens > 0 ? Math.min(100, (conversationTokens / maxTokens) * 100) : 0;

  const keyPool = KeyPoolManager.getInstance();
  const registeredProviders = keyPool.getProviders();
  const now = Date.now();

  const keyPools: SessionUsageData["keyPools"] = {};
  for (const prov of registeredProviders) {
    const slots = keyPool.getKeys(prov);
    const coolingSlots = slots.filter((s) => s.coolingUntil > now);
    const healthySlots = slots.filter((s) => s.coolingUntil <= now);
    const soonestMs = keyPool.getSoonestCooldownMs(prov);

    keyPools[prov] = {
      totalKeys: slots.length,
      healthyKeys: healthySlots.length,
      isCooling: slots.length > 0 && healthySlots.length === 0,
      soonestCooldownSec: Math.ceil(soonestMs / 1000),
      slots: slots.map((s) => ({
        index: s.index,
        maskedKey: maskApiKey(s.key),
        isCooling: s.coolingUntil > now,
        cooldownRemainingSec:
          s.coolingUntil > now ? Math.ceil((s.coolingUntil - now) / 1000) : 0,
        activeRequests: s.activeRequests,
        totalRequests: s.totalRequests,
        errorCount: s.errorCount,
      })),
    };
  }

  const primaryProvider = context.config.provider;
  const chainProviders = getFallbackChain(primaryProvider, context.config);
  let activeProvider = primaryProvider;
  if ((context.provider as any)?.getActiveServingProvider) {
    activeProvider = (context.provider as any).getActiveServingProvider();
  } else if ((context.provider as any)?.inner?.getActiveServingProvider) {
    activeProvider = (context.provider as any).inner.getActiveServingProvider();
  }

  const fallbackChainList: SessionUsageData["fallbackChain"]["chain"] = [];
  for (const p of chainProviders) {
    if (p === "ollama") {
      fallbackChainList.push({
        provider: "ollama",
        status: "READY",
        totalKeys: 0,
        healthyKeys: 1,
        cooldownSec: 0,
      });
      continue;
    }

    const poolInfo = keyPools[p];
    if (!poolInfo || poolInfo.totalKeys === 0) {
      fallbackChainList.push({
        provider: p,
        status: "EMPTY",
        totalKeys: 0,
        healthyKeys: 0,
        cooldownSec: 0,
      });
    } else if (poolInfo.isCooling) {
      fallbackChainList.push({
        provider: p,
        status: "COOLING",
        totalKeys: poolInfo.totalKeys,
        healthyKeys: 0,
        cooldownSec: poolInfo.soonestCooldownSec,
      });
    } else {
      fallbackChainList.push({
        provider: p,
        status: "READY",
        totalKeys: poolInfo.totalKeys,
        healthyKeys: poolInfo.healthyKeys,
        cooldownSec: 0,
      });
    }
  }

  return {
    tokenUsage: {
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      cacheReadTokens: tokenUsage.cacheReadTokens ?? 0,
      cacheWriteTokens: tokenUsage.cacheWriteTokens ?? 0,
      totalTokens,
    },
    contextWindow: {
      model: activeModel,
      conversationTokens,
      maxTokens,
      saturationPercentage,
      messageCount,
      wasCompacted,
    },
    keyPools,
    fallbackChain: {
      primaryProvider,
      activeProvider,
      chain: fallbackChainList,
    },
  };
}

export function formatUsageReport(data: SessionUsageData, section?: string): string {
  const lines: string[] = [];
  const s = section?.trim().toLowerCase();

  const showTokens = !s || s === "tokens" || s === "token";
  const showContext = !s || s === "tokens" || s === "context";
  const showKeys = !s || s === "keys" || s === "pool" || s === "pools";
  const showChain = !s || s === "chain" || s === "fallback" || s === "cascade";

  if (!s) {
    lines.push("╭─────────────────────────────────────────────────────────────╮");
    lines.push("│                 📊 Agav Session & Usage Dashboard           │");
    lines.push("╰─────────────────────────────────────────────────────────────╯");
    lines.push("");
  }

  if (showTokens) {
    lines.push("📈 Session Token Accounting:");
    lines.push(`  • Input Tokens:        ${formatNumber(data.tokenUsage.inputTokens)}`);
    lines.push(`  • Output Tokens:       ${formatNumber(data.tokenUsage.outputTokens)}`);
    lines.push(`  • Cache Read Tokens:   ${formatNumber(data.tokenUsage.cacheReadTokens)}`);
    lines.push(`  • Cache Write Tokens:  ${formatNumber(data.tokenUsage.cacheWriteTokens)}`);
    lines.push("  ─────────────────────────────────────");
    lines.push(`  • Total Cumulative:    ${formatNumber(data.tokenUsage.totalTokens)} tokens`);
    lines.push("");
  }

  if (showContext) {
    const bar = renderProgressBar(data.contextWindow.saturationPercentage, 20);
    lines.push("🧠 Context Window Saturation:");
    lines.push(`  • Active Model:        ${data.contextWindow.model}`);
    lines.push(
      `  • Conversation Usage:  ${formatNumber(data.contextWindow.conversationTokens)} / ${formatNumber(data.contextWindow.maxTokens)} tokens (${data.contextWindow.saturationPercentage.toFixed(1)}%)`,
    );
    lines.push(`  • Saturation Bar:      ${bar}`);
    lines.push(
      `  • Messages in Context: ${data.contextWindow.messageCount} exchanges (Compacted: ${data.contextWindow.wasCompacted ? "Yes" : "No"})`,
    );
    lines.push("");
  }

  if (showKeys) {
    lines.push("🔑 Multi-API-Key Provider Pools:");
    const provNames = Object.keys(data.keyPools);
    if (provNames.length === 0) {
      lines.push("  No API keys registered in key pool. Run '/keys' to add keys.");
    } else {
      for (const prov of provNames) {
        const p = data.keyPools[prov]!;
        const statusBadge = p.isCooling
          ? `○ COOLING (${p.soonestCooldownSec}s remaining)`
          : `● HEALTHY (${p.healthyKeys}/${p.totalKeys} keys ready)`;
        lines.push(`  ${prov} (${p.totalKeys} ${p.totalKeys === 1 ? "key" : "keys"}) [${statusBadge}]:`);
        for (const slot of p.slots) {
          const slotStatus = slot.isCooling
            ? `COOLING (${slot.cooldownRemainingSec}s)`
            : "HEALTHY";
          lines.push(
            `    [Key #${slot.index + 1}] ${slot.maskedKey} | ${slotStatus} | Active: ${slot.activeRequests} | Total: ${slot.totalRequests} | Errors: ${slot.errorCount}`,
          );
        }
      }
    }
    lines.push("");
  }

  if (showChain) {
    lines.push("⚡ Auto-Fallback Cascade Chain:");
    lines.push(`  • Primary Provider:    ${data.fallbackChain.primaryProvider}`);
    lines.push(`  • Active Provider:     ${data.fallbackChain.activeProvider}`);
    lines.push("  • Failover Mesh:       ENABLED (Zero-downtime cross-provider cascade)");
    lines.push("");
    lines.push("  Priority Sequence:");
    data.fallbackChain.chain.forEach((c, idx) => {
      let stateBadge = "";
      if (c.provider === data.fallbackChain.activeProvider) {
        stateBadge = "● ACTIVE";
      } else if (c.status === "READY") {
        stateBadge = `● READY (${c.healthyKeys}/${c.totalKeys} keys)`;
      } else if (c.status === "COOLING") {
        stateBadge = `○ COOLING (${c.cooldownSec}s remaining)`;
      } else {
        stateBadge = "◌ UNCONFIGURED";
      }
      lines.push(`    ${idx + 1}. ${c.provider.padEnd(14)} ${stateBadge}`);
    });
    lines.push("");
    lines.push("Tip: Use '/keys' to manage provider credentials and failover pools interactively.");
    lines.push("Tip: Use '/fast' or '/deep' to switch model tiers across providers.");
  }

  return lines.join("\n").trimEnd();
}

export const usageCommand: SlashCommand = {
  name: "usage",
  description: "Display token usage, context saturation, and API key pool status",
  usage:
    "Usage: /usage [tokens|keys|chain|json]\n\nDisplays detailed session token accounting, context window saturation %, multi-API-key failover pool status, and active provider fallback cascade chain.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const rawTrimmed = args.trim().toLowerCase();
    const data = collectUsageData(context);

    if (rawTrimmed === "json") {
      return {
        type: "message",
        text: JSON.stringify(data, null, 2),
      };
    }

    const text = formatUsageReport(data, rawTrimmed);
    return {
      type: "message",
      text,
    };
  },
};
