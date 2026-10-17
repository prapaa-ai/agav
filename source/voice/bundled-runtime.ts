// Developer-source stub. Release builds replace this module with embed-voice-helper.mjs output.
export interface BundledVoiceRuntime {
  target: string;
  size: number;
  sha256: string;
  gzipBase64: string;
  licenses: { whisper: string; miniaudio: string };
  avx2?: Omit<BundledVoiceRuntime, "avx2">;
}

export const BUNDLED_VOICE_RUNTIME: BundledVoiceRuntime | null = null;
