import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { KeyPoolManager, maskKey, type KeyPoolStatus } from "../providers/key-pool.js";
import { saveConfig, type AgavConfig } from "../config/config.js";
import { PROVIDERS, type ProviderName, isProviderName } from "../config/startup.js";

const VALID_PROVIDERS: readonly string[] = [...PROVIDERS, "groq"];

function getProviderKeyField(provider: string): { single: keyof AgavConfig; multi: keyof AgavConfig } | null {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return { single: "anthropicApiKey", multi: "anthropicApiKeys" };
    case "openai":
      return { single: "openaiApiKey", multi: "openaiApiKeys" };
    case "openrouter":
      return { single: "openrouterApiKey", multi: "openrouterApiKeys" };
    case "nvidia":
      return { single: "nvidiaApiKey", multi: "nvidiaApiKeys" };
    case "deepseek":
      return { single: "deepseekApiKey", multi: "deepseekApiKeys" };
    case "gemini":
      return { single: "geminiApiKey", multi: "geminiApiKeys" };
    case "groq":
      return { single: "groqApiKey", multi: "groqApiKeys" };
    case "ollama":
      return { single: "ollamaApiKey", multi: "ollamaApiKey" as any };
    default:
      return null;
  }
}

export function formatPoolStatus(statusMap: Record<string, KeyPoolStatus>, specificProvider?: string): string {
  const entries = Object.entries(statusMap);
  if (entries.length === 0) {
    return specificProvider
      ? `No keys registered for provider "${specificProvider}".\nUse \`/keys add ${specificProvider} <key>\` to add one.`
      : "No API keys registered in key pool.\nUse `/keys add <provider> <key1,key2...>` to register keys.";
  }

  const lines: string[] = ["Provider Key Pool Status:\n"];
  for (const [provider, status] of entries) {
    const summary = `${provider.toUpperCase()} (${status.totalKeys} key${status.totalKeys === 1 ? "" : "s"}, ${status.activeRequests} active, ${status.coolingKeys} cooling, ${status.totalErrors} errors):`;
    lines.push(summary);

    if (status.keys.length === 0) {
      lines.push("  (No keys registered)");
    } else {
      for (const slot of status.keys) {
        let stateStr = "AVAILABLE";
        if (!slot.enabled) {
          stateStr = "DISABLED";
        } else if (slot.isCooling) {
          const remainingSec = Math.max(1, Math.ceil((slot.coolingUntil - Date.now()) / 1000));
          stateStr = `COOLING (${remainingSec}s remaining)`;
        }
        lines.push(
          `  [${slot.index}] ${slot.key.padEnd(16)}  ${stateStr.padEnd(24)} (active: ${slot.activeRequests}, requests: ${slot.totalRequests}, errors: ${slot.errorCount})`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export const keysCommand: SlashCommand = {
  name: "keys",
  description: "Inspect, add, or clear API keys in the provider key pool",
  usage: "/keys [list|add|clear|<provider>] [keys]",

  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();

    // 1. Help
    if (sub === "help" || sub === "--help" || sub === "-h") {
      return {
        type: "message",
        text: [
          "Keys Management Usage:",
          "  /keys                          View status for all provider key pools",
          "  /keys <provider>               View status for a specific provider (e.g. /keys anthropic)",
          "  /keys add <provider> <keys>    Add one or more comma-separated API keys",
          "  /keys clear <provider>         Clear all keys for a provider",
          "",
          "Examples:",
          "  /keys add anthropic sk-ant-key1,sk-ant-key2",
          "  /keys add openai sk-openai-key1",
          "  /keys clear openrouter",
        ].join("\n"),
      };
    }

    const poolManager = KeyPoolManager.getInstance();

    // 2. Add keys: /keys add <provider> <keys...>
    if (sub === "add") {
      const provider = parts[1]?.toLowerCase();
      if (!provider) {
        return {
          type: "message",
          text: "Missing provider name. Usage: /keys add <provider> <key1,key2...>",
        };
      }

      const keysInput = parts.slice(2).join(" ");
      if (!keysInput.trim()) {
        return {
          type: "message",
          text: `Missing API key(s) to add. Usage: /keys add ${provider} <key1,key2...>`,
        };
      }

      const newKeys = keysInput
        .split(/[,\s]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0);

      if (newKeys.length === 0) {
        return {
          type: "message",
          text: "No valid API keys found in input.",
        };
      }

      // Collect existing keys from config or pool
      const field = getProviderKeyField(provider);
      let existingKeys: string[] = [];
      if (field && context.config) {
        const currentSingle = context.config[field.single] as string | undefined;
        const currentMulti = context.config[field.multi] as string[] | undefined;
        if (Array.isArray(currentMulti) && currentMulti.length > 0) {
          existingKeys = [...currentMulti];
        } else if (currentSingle) {
          existingKeys = [currentSingle];
        }
      }

      const mergedKeys = Array.from(new Set([...existingKeys, ...newKeys]));

      // Register in KeyPoolManager
      poolManager.registerKeys(provider, mergedKeys);

      // Update in-memory context config
      if (field && context.config) {
        (context.config as any)[field.single] = mergedKeys[0];
        (context.config as any)[field.multi] = mergedKeys;
        try {
          await saveConfig(context.config);
        } catch (err: any) {
          return {
            type: "message",
            text: `Keys registered in active pool, but failed to persist to config.json: ${err?.message ?? String(err)}`,
          };
        }
      }

      const maskedPreview = newKeys.map((k) => maskKey(k)).join(", ");
      return {
        type: "message",
        text: `Successfully added ${newKeys.length} key(s) to ${provider} pool (${maskedPreview}).\nTotal registered: ${mergedKeys.length}. Keys saved and encrypted in ~/.agav/config.json.`,
      };
    }

    // 3. Clear keys: /keys clear <provider>
    if (sub === "clear") {
      const provider = parts[1]?.toLowerCase();
      if (!provider) {
        return {
          type: "message",
          text: "Missing provider name. Usage: /keys clear <provider>",
        };
      }

      poolManager.registerKeys(provider, []);

      const field = getProviderKeyField(provider);
      if (field && context.config) {
        (context.config as any)[field.single] = undefined;
        (context.config as any)[field.multi] = [];
        try {
          await saveConfig(context.config);
        } catch (err: any) {
          return {
            type: "message",
            text: `Keys cleared in active pool, but failed to persist to config.json: ${err?.message ?? String(err)}`,
          };
        }
      }

      return {
        type: "message",
        text: `Cleared all API keys for provider "${provider}".`,
      };
    }

    // 4. Specific provider inspection: /keys <provider>
    if (sub && sub !== "list") {
      const statusMap = poolManager.getPoolStatus(sub);
      const text = formatPoolStatus(statusMap, sub);
      return { type: "message", text };
    }

    // 5. General status: /keys or /keys list
    const statusMap = poolManager.getPoolStatus();
    const text = formatPoolStatus(statusMap);
    return { type: "message", text };
  },
};
