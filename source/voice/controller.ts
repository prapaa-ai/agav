import { AudioRecorder } from "./recorder.js";
import { transcribeAudioFile } from "./whisper-local.js";
import type { VoiceState, TranscriptionResult } from "./types.js";

export interface ToggleResult {
  action: "started" | "transcribed" | "cancelled";
  text?: string;
  result?: TranscriptionResult;
}

export class VoiceController {
  private static instance: VoiceController | null = null;
  private recorder = new AudioRecorder();
  private state: VoiceState = "idle";
  private listeners = new Set<(state: VoiceState) => void>();

  static getInstance(): VoiceController {
    if (!VoiceController.instance) {
      VoiceController.instance = new VoiceController();
    }
    return VoiceController.instance;
  }

  static resetInstance(): void {
    if (VoiceController.instance) {
      VoiceController.instance.cancel();
      VoiceController.instance = null;
    }
  }

  getState(): VoiceState {
    return this.state;
  }

  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(newState: VoiceState): void {
    this.state = newState;
    for (const listener of this.listeners) {
      try {
        listener(newState);
      } catch {}
    }
  }

  async start(): Promise<string> {
    if (this.state !== "idle") {
      throw new Error(`Cannot start recording while in state: ${this.state}`);
    }
    this.setState("recording");
    try {
      return await this.recorder.startRecording();
    } catch (err) {
      this.setState("error");
      setTimeout(() => this.setState("idle"), 1500);
      throw err;
    }
  }

  async stopAndTranscribe(): Promise<TranscriptionResult> {
    if (this.state !== "recording") {
      throw new Error(`Cannot stop recording: controller is in state ${this.state}`);
    }

    this.setState("transcribing");
    let audioPath: string | null = null;
    try {
      audioPath = await this.recorder.stopRecording();
      const result = await transcribeAudioFile(audioPath);
      this.setState("idle");
      return result;
    } catch (err) {
      this.setState("error");
      setTimeout(() => this.setState("idle"), 1500);
      throw err;
    }
  }

  cancel(): void {
    this.recorder.cancelRecording();
    this.setState("idle");
  }

  async toggle(): Promise<ToggleResult> {
    if (this.state === "recording") {
      const result = await this.stopAndTranscribe();
      return {
        action: "transcribed",
        text: result.text,
        result,
      };
    }

    if (this.state === "idle") {
      await this.start();
      return { action: "started" };
    }

    // If transcribing or error, cancel back to idle
    this.cancel();
    return { action: "cancelled" };
  }
}
