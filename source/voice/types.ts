/**
 * Voice input and audio recording types for Agav.
 */

export type AudioRecordingState = "idle" | "recording" | "transcribing" | "error";

export interface AudioRecordingResult {
  wavPath: string;
  durationMs: number;
  sampleRate: number;
}

export interface STTResult {
  text: string;
  durationMs: number;
  provider: string;
  model: string;
}

export interface VoiceInputOptions {
  maxDurationMs?: number;
  language?: string;
  prompt?: string;
  provider?: "groq" | "openai" | "local";
  apiKey?: string;
}

export type PartialTranscriptListener = (text: string) => void;

export interface AudioRecorder {
  readonly state?: AudioRecordingState;
  start(): Promise<void>;
  stop(): Promise<AudioRecordingResult>;
  cancel(): Promise<void>;
  getState(): AudioRecordingState;
  snapshot?(destPath: string): Promise<boolean>;
}

export interface STTEngine {
  transcribe(wavPath: string, options?: VoiceInputOptions): Promise<STTResult>;
}
