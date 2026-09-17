import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { VoiceController } from "../voice/controller.js";
import { transcribeAudioFile, isWhisperInstalled, getWhisperInstallGuide } from "../voice/whisper-local.js";

export const micCommand: SlashCommand = {
  name: "mic",
  description: "Control voice dictation recording and transcribe speech to text",
  usage: "/mic [toggle|start|stop|status|transcribe <file>]",

  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase() ?? "toggle";

    if (sub === "help" || sub === "--help" || sub === "-h") {
      return {
        type: "message",
        text: [
          "Microphone & Voice Dictation Usage:",
          "  /mic                 Toggle recording on/off (or press Ctrl+B)",
          "  /mic start           Start recording microphone audio",
          "  /mic stop            Stop recording and transcribe to prompt",
          "  /mic status          Show current recording and Whisper STT status",
          "  /mic transcribe <file> Transcribe an existing audio file (.wav)",
        ].join("\n"),
      };
    }

    const controller = VoiceController.getInstance();

    if (sub === "status") {
      const state = controller.getState();
      const whisperReady = isWhisperInstalled();
      return {
        type: "message",
        text: [
          `Voice Dictation Status:`,
          `  State: ${state.toUpperCase()}`,
          `  Local Whisper Engine: ${whisperReady ? "Installed & Ready" : "Not Found (Run /mic help for install guide)"}`,
          `  Shortcut: Ctrl+B to toggle dictation anywhere`,
        ].join("\n"),
      };
    }

    if (sub === "transcribe") {
      const audioFile = parts.slice(1).join(" ").trim();
      if (!audioFile) {
        return {
          type: "message",
          text: "Missing audio file path. Usage: /mic transcribe <path/to/audio.wav>",
        };
      }

      try {
        const result = await transcribeAudioFile(audioFile);
        return {
          type: "message",
          text: `Transcription (${result.durationMs}ms):\n${result.text}`,
        };
      } catch (err: any) {
        return {
          type: "message",
          text: `Failed to transcribe file: ${err?.message ?? String(err)}`,
        };
      }
    }

    if (sub === "start") {
      try {
        await controller.start();
        context.showStatus?.("Recording microphone audio (press Ctrl+B or run /mic to stop)...");
        return {
          type: "message",
          text: "Microphone recording started. Speak your request and run `/mic` or press `Ctrl+B` to finish.",
        };
      } catch (err: any) {
        return {
          type: "message",
          text: `Could not start recording: ${err?.message ?? String(err)}`,
        };
      }
    }

    if (sub === "stop") {
      try {
        const result = await controller.stopAndTranscribe();
        if (result.isFallback) {
          return { type: "message", text: result.text };
        }
        return {
          type: "submit",
          text: result.text,
        };
      } catch (err: any) {
        return {
          type: "message",
          text: `Failed to transcribe audio: ${err?.message ?? String(err)}`,
        };
      }
    }

    // Default: toggle
    try {
      const toggle = await controller.toggle();
      if (toggle.action === "started") {
        context.showStatus?.("Recording microphone audio (press Ctrl+B or run /mic to stop)...");
        return {
          type: "message",
          text: "Microphone recording started. Speak your prompt and run `/mic` or press `Ctrl+B` when done.",
        };
      }
      if (toggle.action === "transcribed" && toggle.text) {
        if (toggle.result?.isFallback) {
          return { type: "message", text: toggle.text };
        }
        return {
          type: "submit",
          text: toggle.text,
        };
      }
      return {
        type: "message",
        text: "Microphone recording cancelled.",
      };
    } catch (err: any) {
      return {
        type: "message",
        text: `Microphone toggle error: ${err?.message ?? String(err)}`,
      };
    }
  },
};
