import type { SlashCommand } from "./types.js";

export const voiceCommand: SlashCommand = {
  name: "voice",
  description: "Dictate an editable prompt using offline speech recognition",
  usage: "Usage: /voice\n\nSpeak an English prompt: interim text appears directly in the composer. Enter sends the displayed draft once microphone cleanup completes. Click Stop to finish recording without sending and edit the reconciled final draft. Escape or Ctrl+C cancels.\n\nAgav includes its native microphone/transcription helper inside the main binary and extracts it privately when needed. Only the English-only Whisper model needs a download, with URL and exact size shown before Y confirmation. No FFmpeg, whisper-cli, Python, sudo or manual package installation is needed. No separate helper download or release manifest is needed.\n\nAdvanced overrides: AGAV_VOICE_MODEL selects a local English .en model; AGAV_VOICE_HELPER_BIN selects an existing Agav helper; AGAV_VOICE_DEVICE optionally selects an exact microphone name. Default microphones work on all supported platforms.\n\nAudio stays local; submitted text uses the normal LLM provider and history. Allow host microphone access in OS privacy settings. SSH/containers do not forward your laptop mic. Available only in the interactive terminal while idle, without pending attachments.",
  async execute(args, context) {
    if (args.trim()) return { type: "message", text: "Usage: /voice (Enter stops recording; Escape cancels). See /help voice for local setup." };
    if (!context.startVoiceInput) return { type: "message", text: "Voice input requires the interactive terminal UI. See /help voice for local setup." };
    context.startVoiceInput();
    return { type: "none" };
  },
};
