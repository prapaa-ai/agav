import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { KeyPoolManager, type KeySlot } from "../providers/key-pool.js";
import { assignKeysToConfig, saveConfig } from "../config/config.js";
import {
  maskApiKey,
  formatSlotStatus,
  runInteractiveKeysManager,
} from "../config/keys-interactive.js";

export { maskApiKey, formatSlotStatus };

export const keysCommand: SlashCommand = {
  name: "keys",
  description: "View and manage the Multi-API-Key pool and rate-limit status",
  usage: "Usage: /keys [provider] | /keys add <provider> <key1,key2,...> | /keys clear <provider>\n\nDisplays registered keys, healthy/cooling status, cooldown timers, active requests, and error counts per provider without exposing plaintext secrets. Use '/keys add' to store and encrypt keys permanently.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const keyPool = KeyPoolManager.getInstance();
    const rawTrimmed = args.trim();

    // When /keys is invoked with NO arguments in an interactive environment
    if (!rawTrimmed) {
      const isInteractive = Boolean(
        process.stdin.isTTY || typeof context?.suspendTerminal === "function",
      );

      if (isInteractive) {
        context?.setPickerActive?.(true);
        const resume = context?.suspendTerminal ? context.suspendTerminal() : () => {};
        try {
          const text = await runInteractiveKeysManager(context.config, { isTTY: true });
          return { type: "message", text };
        } finally {
          resume();
          context?.setPickerActive?.(false);
          if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
            try {
              process.stdin.setRawMode(true);
              process.stdin.resume();
            } catch {}
          }
          context?.refreshDisplay?.();
        }
      }
    }

    const parts = rawTrimmed.split(/\s+/);
    const subAction = parts[0]?.toLowerCase();
    const now = Date.now();

    // /keys add <provider> <key1,key2,...>
    if (subAction === "add" || subAction === "set") {
      const provider = parts[1]?.toLowerCase();
      const keysInput = parts.slice(2).join(" ").trim();

      if (!provider || !keysInput) {
        return {
          type: "message",
          text: `Usage: /keys ${subAction} <provider> <key1,key2,...>\nExample: /keys add groq gsk_key1, gsk_key2\nExample: /keys add nvidia nvapi-key1, nvapi-key2`,
        };
      }

      const keysToAdd = keysInput
        .split(/[\s,]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0);

      if (keysToAdd.length === 0) {
        return { type: "message", text: "No valid API keys provided." };
      }

      if (context?.config) {
        assignKeysToConfig(context.config, provider, keysToAdd, subAction === "add");
        await saveConfig(context.config);
      }

      // Re-register into KeyPoolManager
      const existingKeys = subAction === "add" ? keyPool.getKeys(provider).map((s) => s.key) : [];
      const combined = Array.from(new Set([...existingKeys, ...keysToAdd]));
      keyPool.registerKeys(provider, combined);

      const updatedSlots = keyPool.getKeys(provider);
      const lines = [
        `✓ Successfully encrypted and saved ${keysToAdd.length} key(s) for '${provider}' into ~/.agav/config.json!`,
        `Multi-API-Key Pool Status for '${provider}' (${updatedSlots.length} active keys):`,
        ...updatedSlots.map((s) => formatSlotStatus(s, now)),
      ];
      return { type: "message", text: lines.join("\n") };
    }

    // /keys clear <provider>
    if (subAction === "clear" || subAction === "remove") {
      const provider = parts[1]?.toLowerCase();
      if (!provider) {
        return {
          type: "message",
          text: "Usage: /keys clear <provider>\nExample: /keys clear nvidia",
        };
      }

      if (context?.config) {
        assignKeysToConfig(context.config, provider, [], false);
        // Clear properties
        switch (provider) {
          case "nvidia": delete context.config.nvidiaApiKey; delete context.config.nvidiaApiKeys; break;
          case "gemini": delete context.config.geminiApiKey; delete context.config.geminiApiKeys; break;
          case "groq": delete (context.config as any).groqApiKey; delete (context.config as any).groqApiKeys; break;
          case "openrouter": delete context.config.openrouterApiKey; delete context.config.openrouterApiKeys; break;
          case "deepseek": delete context.config.deepseekApiKey; delete context.config.deepseekApiKeys; break;
          case "openai": delete context.config.openaiApiKey; delete context.config.openaiApiKeys; break;
          case "anthropic": delete context.config.anthropicApiKey; delete context.config.anthropicApiKeys; break;
        }
        await saveConfig(context.config);
      }

      keyPool.registerKeys(provider, []);
      return {
        type: "message",
        text: `✓ Cleared all API keys for provider '${provider}' from active pool and ~/.agav/config.json.`,
      };
    }

    const specifiedProvider = rawTrimmed.toLowerCase();
    if (specifiedProvider && specifiedProvider !== "status" && specifiedProvider !== "list") {
      const slots = keyPool.getKeys(specifiedProvider);
      if (slots.length === 0) {
        return {
          type: "message",
          text: `No keys registered for provider "${specifiedProvider}".\nUse '/keys add ${specifiedProvider} <key1,key2>' to add keys securely.`,
        };
      }

      const lines = [
        `Multi-API-Key Pool Status for "${specifiedProvider}" (${slots.length} registered):`,
        ...slots.map((s) => formatSlotStatus(s, now)),
      ];
      return { type: "message", text: lines.join("\n") };
    }

    // List all registered providers
    const registeredProviders = new Set<string>(keyPool.getProviders());
    // Also include active provider from config if registered
    if (context?.config?.provider && keyPool.hasKeys(context.config.provider)) {
      registeredProviders.add(context.config.provider.toLowerCase());
    }

    if (registeredProviders.size === 0) {
      return {
        type: "message",
        text: "No API keys are currently registered in the Multi-API-Key pool.\n\nConfigure keys in ~/.agav/config.json or set environment variables such as ANTHROPIC_API_KEYS, OPENAI_API_KEYS, or GROQ_API_KEY.",
      };
    }

    const outputLines: string[] = ["Multi-API-Key Pool Status:"];
    for (const provider of registeredProviders) {
      const slots = keyPool.getKeys(provider);
      if (slots.length > 0) {
        outputLines.push(`\nProvider: ${provider} (${slots.length} keys)`);
        for (const slot of slots) {
          outputLines.push(formatSlotStatus(slot, now));
        }
      }
    }

    return { type: "message", text: outputLines.join("\n") };
  },
};
