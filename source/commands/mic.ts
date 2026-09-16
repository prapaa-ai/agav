import { basename } from "node:path";
import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import {
  VoiceInputController,
  LocalWhisperEngine,
  listAvailableWhisperModels,
  resolveWhisperModel,
} from "../voice/index.js";
import { saveConfig } from "../config/config.js";

function getLocalWhisperStatus(config?: any) {
  const localEngine = new LocalWhisperEngine();
  const info = localEngine.getEngineInfo(config);

  let binaryPath = info.binaryPath || "powershell (winmm.dll)";
  if (process.platform === "linux" && !info.binaryPath) {
    binaryPath = "arecord / sox";
  } else if (process.platform === "darwin" && !info.binaryPath) {
    binaryPath = "sox / rec";
  }

  const modelPath = info.modelPath || process.env.AGAV_WHISPER_MODEL || "ggml-model.bin";
  const modelName = basename(modelPath);

  let availability = "unavailable";
  if (info.isReady) {
    const isMulti =
      modelPath.toLowerCase().includes("turbo") ||
      modelPath.toLowerCase().includes("large") ||
      modelPath.toLowerCase().includes("multi");
    const langCapability = isMulti
      ? "Multilingual (Hindi, Hinglish, English, 100+ languages)"
      : "English / Indic Accents";
    availability = `available (100% offline local Whisper: ${modelName} - ${langCapability})`;
  } else if (process.env.GROQ_API_KEY) {
    availability = "available (Groq Whisper cloud fallback)";
  } else if (process.env.OPENAI_API_KEY) {
    availability = "available (OpenAI Whisper cloud fallback)";
  } else {
    availability = "not configured (set AGAV_WHISPER_BIN/MODEL, or GROQ_API_KEY/OPENAI_API_KEY)";
  }

  const endpoint = info.isReady ? "local-subprocess (whisper-cli.exe)" : "cloud-fallback";
  const language = config?.whisperLanguage || process.env.AGAV_WHISPER_LANG || "auto";

  return {
    binaryPath,
    modelPath,
    modelName,
    endpoint,
    availability,
    language,
    isReady: info.isReady,
  };
}

export const micCommand: SlashCommand = {
  name: "mic",
  description: "Toggle local speech-to-text microphone voice input",
  usage:
    "Usage: /mic [start|stop|status|config] | /mic model [preset|path|list] | /mic lang [auto|hi|en]\n\n" +
    "Controls Agav's native local Whisper voice input.\n\n" +
    "  /mic                  - Toggle microphone recording on/off (hotkey: Ctrl+M)\n" +
    "  /mic start            - Begin recording voice input with real-time waveform\n" +
    "  /mic stop             - Finish recording and transcribe speech locally\n" +
    "  /mic status           - View speech engine readiness, active model, and language\n" +
    "  /mic model list       - List all discovered Whisper models on your system\n" +
    "  /mic model <preset>   - Switch model preset ('turbo', 'small', 'base', or custom path)\n" +
    "  /mic lang <language>  - Set language detection ('auto', 'hi' for Hindi, 'en' for English)",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const rawArgs = args.trim();
    const parts = rawArgs.split(/\s+/);
    const subAction = parts[0]?.toLowerCase() || "";
    const controller = VoiceInputController.getInstance();

    if (subAction === "status") {
      const status = getLocalWhisperStatus(context?.config);
      const state = controller.getState();
      const discovered = listAvailableWhisperModels();

      const lines = [
        "Local Whisper Voice Engine Status:",
        `  - Status: ${state}`,
        `  - Binary Path / Audio Driver: ${status.binaryPath}`,
        `  - Model Path / Name: ${status.modelPath}`,
        `  - Endpoint: ${status.endpoint}`,
        `  - Engine Availability: ${status.availability}`,
        `  - Active Model: ${status.modelName} (${status.modelPath})`,
        `  - Language Mode: ${status.language}`,
        `  - Discovered Models on Disk: ${discovered.length} model(s) available`,
      ];

      if (discovered.length > 0) {
        lines.push("\nDiscovered Local Models:");
        for (const m of discovered) {
          lines.push(`    • ${m.name} (${m.sizeMb} MB) - ${m.recommendedFor}`);
        }
      }

      return { type: "message", text: lines.join("\n") };
    }

    if (subAction === "config") {
      const status = getLocalWhisperStatus(context?.config);
      const lines = [
        "Local Whisper Configuration:",
        `  - Endpoint: ${status.endpoint}`,
        `  - Model: ${status.modelPath}`,
        `  - Language: ${status.language}`,
        `  - Binary Driver: ${status.binaryPath}`,
        "  - Environment Variables: LOCAL_WHISPER_URL, LOCAL_WHISPER_MODEL, LOCAL_WHISPER_API_KEY, AGAV_WHISPER_BIN, AGAV_WHISPER_MODEL, AGAV_WHISPER_LANG, GROQ_API_KEY, OPENAI_API_KEY",
      ];
      return { type: "message", text: lines.join("\n") };
    }

    if (subAction === "model") {
      const modelArg = parts.slice(1).join(" ").trim();
      const discovered = listAvailableWhisperModels();

      if (!modelArg || modelArg.toLowerCase() === "list") {
        if (discovered.length === 0) {
          return {
            type: "message",
            text:
              "No local Whisper models (.bin) found on disk in ~/.agav/models or C:\\models.\n" +
              "To install a model, place a GGML model file in C:\\models or ~/.agav/models/.\n" +
              "Example: C:\\models\\ggml-large-v3-turbo-q5_0.bin (574 MB, Multilingual/Hinglish/Hindi)",
          };
        }

        const lines = [
          "Available Local Whisper Models (Discovered):",
          ...discovered.map(
            (m, i) =>
              `  [${i + 1}] ${m.name} (${m.sizeMb} MB) - ${m.recommendedFor}\n      Path: ${m.path}`,
          ),
          "\nTo activate a model, run:",
          "  /mic model turbo   (Activates Multilingual Hindi/Hinglish/English model)",
          "  /mic model small   (Activates Indian-English accent tuned model)",
          "  /mic model base    (Activates Ultra-Fast CPU model)",
          "  /mic model <path>  (Activates any specific .bin file)",
        ];
        return { type: "message", text: lines.join("\n") };
      }

      const resolved = resolveWhisperModel(modelArg, context?.config);
      if (!resolved) {
        return {
          type: "message",
          text: `Could not resolve model preset or path '${modelArg}'.\nUse '/mic model list' to inspect available models.`,
        };
      }

      if (context?.config) {
        context.config.whisperModelPath = resolved;
        await saveConfig(context.config);
      }

      return {
        type: "message",
        text: `✓ Successfully switched local Whisper model to '${basename(resolved)}' (${resolved}). Saved to ~/.agav/config.json.`,
      };
    }

    if (subAction === "lang" || subAction === "language") {
      const langArg = parts[1]?.toLowerCase();
      if (!langArg) {
        const currentLang = context?.config?.whisperLanguage || "auto";
        return {
          type: "message",
          text: `Current Whisper language mode: ${currentLang}\nUsage: /mic lang <auto|hi|en>`,
        };
      }

      if (context?.config) {
        context.config.whisperLanguage = langArg;
        await saveConfig(context.config);
      }

      return {
        type: "message",
        text: `✓ Voice transcription language detection set to '${langArg}'. Saved to ~/.agav/config.json.`,
      };
    }

    if (subAction === "start") {
      if (controller.getState() === "recording") {
        return {
          type: "message",
          text: "Voice recording is already active. Press Ctrl+M or use /mic stop to finish.",
        };
      }
      try {
        const lang = context?.config?.whisperLanguage;
        await controller.start(lang ? { language: lang } : undefined);
        return {
          type: "message",
          text: "🎤 Voice input started. Speak now, then press Ctrl+M, Enter, or run /mic stop.",
        };
      } catch (err: any) {
        return {
          type: "message",
          text: `Failed to start voice input: ${err.message || String(err)}`,
        };
      }
    }

    if (subAction === "stop") {
      if (controller.getState() !== "recording") {
        return { type: "message", text: "Voice input is not currently recording." };
      }
      try {
        const text = await controller.stop();
        if (!text || !text.trim()) {
          return { type: "message", text: "Voice input stopped. No speech was detected." };
        }
        return { type: "message", text: `🎤 Transcription: ${text}` };
      } catch (err: any) {
        return {
          type: "message",
          text: `Failed to transcribe voice input: ${err.message || String(err)}`,
        };
      }
    }

    if (!subAction) {
      // Toggle voice input
      const state = controller.getState();
      if (state === "idle" || state === "error") {
        try {
          const lang = context?.config?.whisperLanguage;
          await controller.start(lang ? { language: lang } : undefined);
          return {
            type: "message",
            text: "🎤 Voice input started. Speak now, then press Ctrl+M or run /mic stop.",
          };
        } catch (err: any) {
          return {
            type: "message",
            text: `Failed to start voice input: ${err.message || String(err)}`,
          };
        }
      } else if (state === "recording") {
        try {
          const text = await controller.stop();
          if (!text || !text.trim()) {
            return { type: "message", text: "Voice input stopped. No speech was detected." };
          }
          return { type: "message", text: `🎤 Transcription: ${text}` };
        } catch (err: any) {
          return {
            type: "message",
            text: `Failed to transcribe voice input: ${err.message || String(err)}`,
          };
        }
      } else if (state === "transcribing") {
        return { type: "message", text: "⏳ Currently transcribing speech locally. Please wait..." };
      }
    }

    return {
      type: "message",
      text: `Unknown argument: "${rawArgs}".\n${micCommand.usage}`,
    };
  },
};
