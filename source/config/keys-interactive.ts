import * as readline from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { assignKeysToConfig, saveConfig, type AgavConfig } from "./config.js";
import { KeyPoolManager, type KeySlot } from "../providers/key-pool.js";

/** Mask API keys to keep plaintext secrets confidential. */
export function maskApiKey(key: string): string {
  if (!key) return "(empty)";
  const trimmed = key.trim();
  if (trimmed.length <= 8) {
    return "****" + (trimmed.length > 2 ? trimmed.slice(-2) : "");
  }
  const prefix = trimmed.slice(0, Math.min(7, Math.floor(trimmed.length / 3)));
  const suffix = trimmed.slice(-4);
  return `${prefix}...${suffix}`;
}

/** Formats a KeySlot's status into a readable string. */
export function formatSlotStatus(slot: KeySlot, now: number): string {
  const isCooling = slot.coolingUntil > now;
  const remainingCooldownSec = isCooling ? Math.ceil((slot.coolingUntil - now) / 1000) : 0;
  const statusStr = isCooling ? `COOLING (${remainingCooldownSec}s remaining)` : "HEALTHY";
  const masked = maskApiKey(slot.key);

  return `  [Key #${slot.index + 1}] ${masked} | Status: ${statusStr} | Cooldown: ${remainingCooldownSec}s | Active: ${slot.activeRequests} | Total: ${slot.totalRequests} | Errors: ${slot.errorCount}`;
}

export const KNOWN_PROVIDERS = [
  "groq",
  "openrouter",
  "nvidia",
  "gemini",
  "openai",
  "anthropic",
  "deepseek",
  "ollama",
] as const;

export interface SupportedProviderInfo {
  id: string;
  name: string;
  description: string;
  isOffline?: boolean;
}

export const SUPPORTED_PROVIDERS: SupportedProviderInfo[] = [
  { id: "groq", name: "groq", description: "Groq Cloud API (Ultra-fast Whisper & Llama models)" },
  { id: "openrouter", name: "openrouter", description: "OpenRouter API (Claude, DeepSeek, GPT-4o, etc.)" },
  { id: "nvidia", name: "nvidia", description: "NVIDIA NIM API (DeepSeek-V3, Llama 3.3, Nemotron)" },
  { id: "gemini", name: "gemini", description: "Google Gemini API / AI Studio (Gemini 2.5, 2.0 Flash)" },
  { id: "openai", name: "openai", description: "OpenAI API (GPT-4o, o3-mini, Whisper)" },
  { id: "anthropic", name: "anthropic", description: "Anthropic Claude API (Sonnet 3.5/3.7, Opus)" },
  { id: "deepseek", name: "deepseek", description: "DeepSeek Direct API (DeepSeek-V3, DeepSeek-R1)" },
  { id: "ollama", name: "ollama", description: "Local Ollama (100% offline, zero API keys)", isOffline: true },
];

/** Clears API keys for a provider from AgavConfig properties. */
export function clearKeysFromConfig(config: AgavConfig, provider: string): void {
  assignKeysToConfig(config, provider, [], false);
  const norm = provider.toLowerCase().trim();
  switch (norm) {
    case "nvidia":
      delete config.nvidiaApiKey;
      delete config.nvidiaApiKeys;
      break;
    case "gemini":
      delete config.geminiApiKey;
      delete config.geminiApiKeys;
      break;
    case "groq":
      delete (config as any).groqApiKey;
      delete (config as any).groqApiKeys;
      break;
    case "openrouter":
      delete config.openrouterApiKey;
      delete config.openrouterApiKeys;
      break;
    case "deepseek":
      delete config.deepseekApiKey;
      delete config.deepseekApiKeys;
      break;
    case "openai":
      delete config.openaiApiKey;
      delete config.openaiApiKeys;
      break;
    case "anthropic":
      delete config.anthropicApiKey;
      delete config.anthropicApiKeys;
      break;
  }
}

/** Lists all providers that currently have registered keys in pool or config. */
export function getProvidersWithKeys(config: AgavConfig): string[] {
  const registered = new Set<string>();
  const keyPool = KeyPoolManager.getInstance();
  for (const p of keyPool.getProviders()) {
    if (keyPool.getKeys(p).length > 0) {
      registered.add(p.toLowerCase());
    }
  }
  if ((config as any).groqApiKey || (config as any).groqApiKeys?.length) registered.add("groq");
  if (config.openrouterApiKey || config.openrouterApiKeys?.length) registered.add("openrouter");
  if (config.nvidiaApiKey || config.nvidiaApiKeys?.length) registered.add("nvidia");
  if (config.geminiApiKey || config.geminiApiKeys?.length) registered.add("gemini");
  if (config.openaiApiKey || config.openaiApiKeys?.length) registered.add("openai");
  if (config.anthropicApiKey || config.anthropicApiKeys?.length) registered.add("anthropic");
  if (config.deepseekApiKey || config.deepseekApiKeys?.length) registered.add("deepseek");

  return KNOWN_PROVIDERS.filter((p) => registered.has(p));
}

export interface RunInteractiveKeysOptions {
  customRl?: readline.Interface;
  forceInteractive?: boolean;
  isTTY?: boolean;
}

/**
 * Runs the interactive Multi-API-Key manager wizard.
 */
export async function runInteractiveKeysManager(
  config: AgavConfig,
  options?: RunInteractiveKeysOptions,
): Promise<string> {
  const isInteractive = Boolean(
    options?.customRl || options?.forceInteractive || options?.isTTY || defaultInput.isTTY,
  );

  if (!isInteractive) {
    return "Multi-API-Key Manager requires an interactive terminal.";
  }

  const rl = options?.customRl || readline.createInterface({ input: defaultInput, output: defaultOutput });
  const keyPool = KeyPoolManager.getInstance();

  try {
    defaultOutput.write("\n");
    defaultOutput.write("╭─────────────────────────────────────────────────────────────╮\n");
    defaultOutput.write("│                 🔑 Agav Multi-API-Key Manager               │\n");
    defaultOutput.write("╰─────────────────────────────────────────────────────────────╯\n\n");
    defaultOutput.write("Manage your AI provider credentials and failover pools:\n\n");
    defaultOutput.write("[1] 📋 View All Registered Keys & Pool Status\n");
    defaultOutput.write("[2] ➕ Add Key(s) to a Provider\n");
    defaultOutput.write("[3] ✏️  Update / Replace Keys for a Provider\n");
    defaultOutput.write("[4] ❌ Remove / Clear Keys for a Provider\n");
    defaultOutput.write("[5] 🚪 Exit\n\n");

    const choice = (await rl.question("Select an option [1-5]: ")).trim();

    // Option [1] - View All Registered Keys & Pool Status
    if (choice === "1") {
      const now = Date.now();
      const lines: string[] = ["Multi-API-Key Pool Status:"];
      let totalKeys = 0;

      for (const p of KNOWN_PROVIDERS) {
        if (p === "ollama") {
          const isActive = config.provider === "ollama";
          lines.push(`\nProvider: ollama (${isActive ? "Active - " : ""}Local Ollama, 100% offline, zero API keys required)`);
          continue;
        }

        const slots = keyPool.getKeys(p);
        if (slots.length > 0) {
          totalKeys += slots.length;
          lines.push(`\nProvider: ${p} (${slots.length} keys)`);
          for (const slot of slots) {
            lines.push(formatSlotStatus(slot, now));
          }
        } else {
          lines.push(`\nProvider: ${p} (0 keys registered)`);
          lines.push(`  No keys registered. Use option [2] or '/keys add ${p} <key1,key2>' to add keys.`);
        }
      }

      if (totalKeys === 0 && config.provider !== "ollama") {
        lines.push("\nNo API keys are currently registered in the Multi-API-Key pool.\nUse option [2] to add API keys or configure ~/.agav/config.json.");
      }

      const text = lines.join("\n");
      defaultOutput.write("\n" + text + "\n");
      return text;
    }

    // Option [2] (Add) and Option [3] (Update/Replace)
    if (choice === "2" || choice === "3") {
      defaultOutput.write("\nSupported AI Providers:\n");
      defaultOutput.write("  [1] groq        - Groq Cloud API (Ultra-fast Whisper & Llama models)\n");
      defaultOutput.write("  [2] openrouter  - OpenRouter API (Claude, DeepSeek, GPT-4o, etc.)\n");
      defaultOutput.write("  [3] nvidia      - NVIDIA NIM API (DeepSeek-V3, Llama 3.3, Nemotron)\n");
      defaultOutput.write("  [4] gemini      - Google Gemini API / AI Studio (Gemini 2.5, 2.0 Flash)\n");
      defaultOutput.write("  [5] openai      - OpenAI API (GPT-4o, o3-mini, Whisper)\n");
      defaultOutput.write("  [6] anthropic   - Anthropic Claude API (Sonnet 3.5/3.7, Opus)\n");
      defaultOutput.write("  [7] deepseek    - DeepSeek Direct API (DeepSeek-V3, DeepSeek-R1)\n");
      defaultOutput.write("  [8] ollama      - Local Ollama (100% offline, zero API keys)\n\n");

      const provChoice = (await rl.question("Select a provider [1-8] or enter name: ")).trim().toLowerCase();

      const providerMap: Record<string, string> = {
        "1": "groq",
        "groq": "groq",
        "2": "openrouter",
        "openrouter": "openrouter",
        "3": "nvidia",
        "nvidia": "nvidia",
        "4": "gemini",
        "gemini": "gemini",
        "5": "openai",
        "openai": "openai",
        "6": "anthropic",
        "anthropic": "anthropic",
        "7": "deepseek",
        "deepseek": "deepseek",
        "8": "ollama",
        "ollama": "ollama",
      };

      const selectedProvider = providerMap[provChoice];
      if (!selectedProvider) {
        const text = `Invalid provider '${provChoice}'. Operation cancelled.`;
        defaultOutput.write("\n" + text + "\n");
        return text;
      }

      if (selectedProvider === "ollama") {
        config.provider = "ollama";
        await saveConfig(config);
        const text = "✓ Switched provider to 'ollama' (100% offline, zero API keys required). Saved to ~/.agav/config.json.";
        defaultOutput.write("\n" + text + "\n");
        return text;
      }

      defaultOutput.write(`\nEnter API key(s) for '${selectedProvider}':\n`);
      defaultOutput.write("Tip: Separate multiple keys with commas to enable automated rate-limit pool failover!\n");
      const rawKeys = (await rl.question(`Enter API key(s) for '${selectedProvider}': `)).trim();

      if (!rawKeys) {
        const text = `No API key entered for '${selectedProvider}'. Operation cancelled.`;
        defaultOutput.write("\n" + text + "\n");
        return text;
      }

      const keys = rawKeys
        .split(/[\s,]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0);

      if (keys.length === 0) {
        const text = `No valid API keys provided for '${selectedProvider}'. Operation cancelled.`;
        defaultOutput.write("\n" + text + "\n");
        return text;
      }

      const isAdd = choice === "2";
      assignKeysToConfig(config, selectedProvider, keys, isAdd);
      await saveConfig(config);

      const existingKeys = isAdd ? keyPool.getKeys(selectedProvider).map((s) => s.key) : [];
      const updatedKeys = Array.from(new Set([...existingKeys, ...keys]));
      keyPool.registerKeys(selectedProvider, updatedKeys);

      const updatedSlots = keyPool.getKeys(selectedProvider);
      const now = Date.now();
      const lines = [
        `✓ Successfully encrypted and saved ${keys.length} key(s) for '${selectedProvider}' in ~/.agav/config.json!`,
        `Multi-API-Key Pool Status for '${selectedProvider}' (${updatedSlots.length} active keys):`,
        ...updatedSlots.map((s) => formatSlotStatus(s, now)),
      ];
      const text = lines.join("\n");
      defaultOutput.write("\n" + text + "\n");
      return text;
    }

    // Option [4] - Remove / Clear Keys for a Provider
    if (choice === "4") {
      const activeProviders = getProvidersWithKeys(config);
      if (activeProviders.length === 0) {
        const text = "No providers currently have registered API keys to clear.";
        defaultOutput.write("\n" + text + "\n");
        return text;
      }

      defaultOutput.write("\nRegistered providers with API keys:\n");
      activeProviders.forEach((p, idx) => {
        const count = keyPool.getKeys(p).length;
        defaultOutput.write(`  [${idx + 1}] ${p} (${count} key${count === 1 ? "" : "s"})\n`);
      });

      const provInput = (await rl.question(`\nSelect provider to clear [1-${activeProviders.length}] or enter name: `)).trim().toLowerCase();

      let targetProvider: string | undefined;
      const num = parseInt(provInput, 10);
      if (!isNaN(num) && num >= 1 && num <= activeProviders.length) {
        targetProvider = activeProviders[num - 1];
      } else if (activeProviders.includes(provInput)) {
        targetProvider = provInput;
      }

      if (!targetProvider) {
        const text = `No matching provider '${provInput}'. Operation cancelled.`;
        defaultOutput.write("\n" + text + "\n");
        return text;
      }

      clearKeysFromConfig(config, targetProvider);
      keyPool.registerKeys(targetProvider, []);
      await saveConfig(config);

      const text = `✓ Cleared all API keys for provider '${targetProvider}'.`;
      defaultOutput.write("\n" + text + "\n");
      return text;
    }

    // Option [5] - Exit
    if (choice === "5" || !choice) {
      const text = "Exited Multi-API-Key Manager.";
      defaultOutput.write("\n" + text + "\n");
      return text;
    }

    const text = `Invalid option '${choice}'. Exited Multi-API-Key Manager.`;
    defaultOutput.write("\n" + text + "\n");
    return text;
  } finally {
    if (!options?.customRl) {
      rl.close();
      if (defaultInput.isTTY && typeof defaultInput.setRawMode === "function") {
        try {
          defaultInput.setRawMode(true);
          defaultInput.resume();
        } catch {}
      }
    }
  }
}
