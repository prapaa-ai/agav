export type VoiceState = "idle" | "recording" | "transcribing" | "error";

export type AudioFormat = "wav" | "pcm";

export interface RecordingOptions {
  sampleRate?: number;
  channels?: number;
  outputFile?: string;
  maxDurationSec?: number;
  silenceTimeoutSec?: number;
}

export interface TranscriptionOptions {
  model?: string;
  language?: string;
  temperature?: number;
  prompt?: string;
  whisperPath?: string;
}

export interface TranscriptionResult {
  text: string;
  rawText: string;
  durationMs: number;
  language?: string;
  isFallback?: boolean;
}
