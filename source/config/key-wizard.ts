import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { assignKeysToConfig, saveConfig, type AgavConfig } from "./config.js";

export interface KeySetupResult {
  configured: boolean;
  provider?: string;
  keysAdded?: number;
}

/**
 * Interactive API Key Setup Wizard for Agav.
 *
 * Prompts the user directly in their terminal when no provider credentials exist,
 * allowing single or multiple comma-separated keys to be entered cleanly without
 * manually modifying environment variables or JSON files. Keys are automatically
 * encrypted at rest with AES-256-GCM.
 */
export async function runInteractiveKeySetup(
  config: AgavConfig,
  forcedProvider?: string,
  customRl?: readline.Interface,
): Promise<KeySetupResult> {
  // If not running in an interactive terminal, cannot prompt interactively
  if (!input.isTTY && !customRl) {
    return { configured: false };
  }

  const rl = customRl || readline.createInterface({ input, output });

  try {
    const targetProvider = (forcedProvider || config.provider || "nvidia").toLowerCase();

    output.write("\n");
    output.write("  ╭─────────────────────────────────────────────────────────────╮\n");
    output.write("  │                   🔑 Agav Key Setup Wizard                  │\n");
    output.write("  ╰─────────────────────────────────────────────────────────────╯\n\n");
    output.write(`  No credentials found for provider '${targetProvider}'.\n`);
    output.write("  You don't need to type $env:KEY in PowerShell or edit JSON files!\n\n");
    output.write(`  [1] Enter API key(s) for '${targetProvider}' (supports multiple keys)\n`);
    output.write("  [2] Switch provider (gemini, groq, openrouter, nvidia, deepseek, openai, anthropic, ollama)\n");
    output.write("  [3] Use local Ollama (100% offline, zero API keys required)\n");
    output.write("  [4] Exit\n\n");

    const choice = (await rl.question("  Select an option [1-4] (default: 1): ")).trim() || "1";

    if (choice === "3") {
      config.provider = "ollama";
      await saveConfig(config);
      output.write("\n  ✓ Switched provider to 'ollama'. Saved to ~/.agav/config.json.\n\n");
      return { configured: true, provider: "ollama" };
    }

    if (choice === "4") {
      return { configured: false };
    }

    let activeProvider = targetProvider;
    if (choice === "2") {
      output.write("\n  Supported providers:\n");
      output.write("    - gemini      (Google Gemini API / AI Studio)\n");
      output.write("    - groq        (Groq Cloud API)\n");
      output.write("    - openrouter  (OpenRouter API)\n");
      output.write("    - nvidia      (NVIDIA NIM API)\n");
      output.write("    - deepseek    (DeepSeek API)\n");
      output.write("    - openai      (OpenAI API)\n");
      output.write("    - anthropic   (Anthropic API)\n");
      output.write("    - ollama      (Local Ollama, offline)\n\n");

      const provInput = (await rl.question("  Enter provider name: ")).trim().toLowerCase();
      if (!provInput) {
        return { configured: false };
      }
      activeProvider = provInput;
      (config as any).provider = activeProvider;

      if (activeProvider === "ollama") {
        await saveConfig(config);
        output.write("\n  ✓ Switched provider to 'ollama'. Saved to ~/.agav/config.json.\n\n");
        return { configured: true, provider: "ollama" };
      }
    }

    output.write(`\n  Enter API key(s) for '${activeProvider}':\n`);
    output.write("  (Tip: Paste multiple keys separated by comma to enable automatic failover pool)\n");
    const rawKeys = (await rl.question("  > API Key: ")).trim();

    if (!rawKeys) {
      output.write("\n  No API key entered. Setup cancelled.\n\n");
      return { configured: false };
    }

    const keys = rawKeys
      .split(/[\s,]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (keys.length === 0) {
      return { configured: false };
    }

    // Assign and save encrypted
    assignKeysToConfig(config, activeProvider, keys, false);
    await saveConfig(config);

    output.write(`\n  ✓ Successfully encrypted and saved ${keys.length} key(s) for '${activeProvider}' in ~/.agav/config.json.\n`);
    output.write("  Your credentials are encrypted at rest with AES-256-GCM. Starting Agav...\n\n");

    return { configured: true, provider: activeProvider, keysAdded: keys.length };
  } finally {
    if (!customRl) {
      rl.close();
    }
  }
}
