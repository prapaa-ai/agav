import * as readline from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { saveConfig, type AgavConfig } from "./config.js";
import { PROVIDERS, defaultModelForProvider, type ProviderName, isProviderName } from "./startup.js";
import { KeyPoolManager, maskKey } from "../providers/key-pool.js";

export interface KeyWizardIO {
  prompt(question: string): Promise<string>;
  write(message: string): void;
}

export function createDefaultWizardIO(): KeyWizardIO {
  const rl = readline.createInterface({
    input: defaultStdin,
    output: defaultStdout,
  });

  return {
    prompt: async (question: string) => {
      const answer = await rl.question(question);
      return answer.trim();
    },
    write: (message: string) => {
      defaultStdout.write(message + "\n");
    },
  };
}

export async function runInteractiveKeySetup(
  config: AgavConfig,
  targetProvider?: ProviderName,
  io: KeyWizardIO = createDefaultWizardIO(),
): Promise<AgavConfig | null> {
  try {
    io.write("\n╔════════════════════════════════════════════════════════════════════╗");
    io.write("║                 Agav — Provider Key Setup Wizard                   ║");
    io.write("╚════════════════════════════════════════════════════════════════════╝");
    io.write("No configured API credentials found for an inference provider.\n");

    let selectedProvider: ProviderName;

    if (targetProvider && isProviderName(targetProvider) && targetProvider !== "ollama") {
      selectedProvider = targetProvider;
      io.write(`Configuring provider: ${selectedProvider}`);
    } else {
      io.write("Select a provider to configure:");
      io.write("  [1] anthropic   (Claude 3.5 Sonnet / Claude 3.7 Sonnet)");
      io.write("  [2] openai      (GPT-4o / GPT-5)");
      io.write("  [3] openrouter  (Auto-routing to 100+ models)");
      io.write("  [4] nvidia      (Nemotron / Llama / DeepSeek on NIM)");
      io.write("  [5] deepseek    (DeepSeek V3 / R1)");
      io.write("  [6] gemini      (Gemini 2.0 Flash / Pro)");

      const choice = await io.prompt("\nEnter choice (1-6) or provider name [default: anthropic]: ");

      switch (choice.toLowerCase()) {
        case "1":
        case "anthropic":
        case "":
          selectedProvider = "anthropic";
          break;
        case "2":
        case "openai":
          selectedProvider = "openai";
          break;
        case "3":
        case "openrouter":
          selectedProvider = "openrouter";
          break;
        case "4":
        case "nvidia":
          selectedProvider = "nvidia";
          break;
        case "5":
        case "deepseek":
          selectedProvider = "deepseek";
          break;
        case "6":
        case "gemini":
          selectedProvider = "gemini";
          break;
        default:
          if (isProviderName(choice.toLowerCase())) {
            selectedProvider = choice.toLowerCase() as ProviderName;
          } else {
            io.write(`Unrecognized choice "${choice}". Aborting setup wizard.`);
            return null;
          }
      }
    }

    const keyInput = await io.prompt(
      `\nEnter API key for ${selectedProvider} (comma-separated for key rotation): `,
    );

    if (!keyInput.trim()) {
      io.write("No API key entered. Aborting setup wizard.\n");
      return null;
    }

    const keys = keyInput
      .split(/[,\s]+/)
      .map((k) => k.trim())
      .filter(Boolean);

    if (keys.length === 0) {
      io.write("No valid API keys found. Aborting setup wizard.\n");
      return null;
    }

    // Register in KeyPoolManager
    KeyPoolManager.getInstance().registerKeys(selectedProvider, keys);

    const updatedConfig: AgavConfig = {
      ...config,
      provider: selectedProvider,
      model: config.model || defaultModelForProvider(selectedProvider),
    };

    switch (selectedProvider) {
      case "anthropic":
        updatedConfig.anthropicApiKey = keys[0];
        updatedConfig.anthropicApiKeys = keys;
        break;
      case "openai":
        updatedConfig.openaiApiKey = keys[0];
        updatedConfig.openaiApiKeys = keys;
        break;
      case "openrouter":
        updatedConfig.openrouterApiKey = keys[0];
        updatedConfig.openrouterApiKeys = keys;
        break;
      case "nvidia":
        updatedConfig.nvidiaApiKey = keys[0];
        updatedConfig.nvidiaApiKeys = keys;
        break;
      case "deepseek":
        updatedConfig.deepseekApiKey = keys[0];
        updatedConfig.deepseekApiKeys = keys;
        break;
      case "gemini":
        updatedConfig.geminiApiKey = keys[0];
        updatedConfig.geminiApiKeys = keys;
        break;
    }

    await saveConfig(updatedConfig);

    const maskedList = keys.map((k) => maskKey(k)).join(", ");
    io.write(`\n✓ Configured ${selectedProvider} with ${keys.length} key(s): ${maskedList}`);
    io.write("✓ Encrypted credentials saved to ~/.agav/config.json\n");

    return updatedConfig;
  } catch (err: any) {
    io.write(`Setup wizard error: ${err?.message ?? String(err)}`);
    return null;
  }
}
