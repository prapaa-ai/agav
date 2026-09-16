import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AudioRecorder,
  AudioRecordingResult,
  AudioRecordingState,
  PartialTranscriptListener,
  STTEngine,
  VoiceInputOptions,
} from "./types.js";
import { NativeAudioRecorder } from "./recorder.js";
import { WhisperSTTEngine } from "./stt.js";

export class VoiceInputController {
  private static instance: VoiceInputController | null = null;
  private state: AudioRecordingState = "idle";
  private listeners: Set<(state: AudioRecordingState) => void> = new Set();
  private partialListeners: Set<PartialTranscriptListener> = new Set();
  private recorder: AudioRecorder;
  private sttEngine: STTEngine;
  private currentOptions?: VoiceInputOptions;
  private autoStopTimeout?: NodeJS.Timeout;
  private partialTimer?: NodeJS.Timeout;
  private isTranscribingPartial = false;
  private lastPartialText = "";

  constructor(recorder?: AudioRecorder, sttEngine?: STTEngine) {
    this.recorder = recorder || new NativeAudioRecorder();
    this.sttEngine = sttEngine || new WhisperSTTEngine();
  }

  public static getInstance(recorder?: AudioRecorder, sttEngine?: STTEngine): VoiceInputController {
    if (!VoiceInputController.instance) {
      VoiceInputController.instance = new VoiceInputController(recorder, sttEngine);
    }
    return VoiceInputController.instance;
  }

  public static resetInstance(): void {
    if (VoiceInputController.instance) {
      VoiceInputController.instance.cancel().catch(() => {});
      VoiceInputController.instance = null;
    }
  }

  public getState(): AudioRecordingState {
    return this.state;
  }

  public onStateChange(listener: (state: AudioRecordingState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public onPartialTranscript(listener: PartialTranscriptListener): () => void {
    this.partialListeners.add(listener);
    return () => {
      this.partialListeners.delete(listener);
    };
  }

  public async start(options?: VoiceInputOptions): Promise<void> {
    if (this.state === "recording" || this.state === "transcribing") {
      throw new Error("Voice input is already active");
    }

    this.clearAutoStopTimer();
    this.clearPartialLoop();
    this.currentOptions = options;
    this.lastPartialText = "";

    try {
      await this.recorder.start();
      this.setState("recording");

      this.startPartialLoop();

      if (options?.maxDurationMs && options.maxDurationMs > 0) {
        this.autoStopTimeout = setTimeout(async () => {
          if (this.state === "recording") {
            try {
              await this.stop();
            } catch {
              // Any error during auto-stop is handled by stop()
            }
          }
        }, options.maxDurationMs);
      }
    } catch (error) {
      this.clearPartialLoop();
      this.setState("error");
      throw error;
    }
  }

  public async stop(): Promise<string> {
    this.clearAutoStopTimer();
    this.clearPartialLoop();

    if (this.state !== "recording") {
      throw new Error("Voice input is not recording");
    }

    let recordResult: AudioRecordingResult;
    try {
      recordResult = await this.recorder.stop();
    } catch (error) {
      this.setState("error");
      throw error;
    }

    this.setState("transcribing");
    try {
      const sttResult = await this.sttEngine.transcribe(recordResult.wavPath, this.currentOptions);
      this.setState("idle");
      const finalText = sttResult.text ? sttResult.text.trim() : "";
      if (finalText) {
        this.notifyPartialListeners(finalText);
      }
      this.lastPartialText = "";
      return finalText;
    } catch (error) {
      this.setState("error");
      throw error;
    } finally {
      if (recordResult?.wavPath) {
        await unlink(recordResult.wavPath).catch(() => {});
      }
    }
  }

  public async cancel(): Promise<void> {
    this.clearAutoStopTimer();
    this.clearPartialLoop();
    this.lastPartialText = "";

    try {
      await this.recorder.cancel();
    } finally {
      this.setState("idle");
    }
  }

  private startPartialLoop(): void {
    if (typeof this.recorder.snapshot !== "function") {
      return;
    }

    const runSnapshotCycle = async () => {
      if (this.state !== "recording") {
        return;
      }
      if (this.isTranscribingPartial) {
        return;
      }

      this.isTranscribingPartial = true;
      const snapPath = join(
        tmpdir(),
        `agav_snap_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`,
      );

      try {
        const ok = await this.recorder.snapshot!(snapPath);
        if (ok && this.state === "recording" && existsSync(snapPath)) {
          const result = await this.sttEngine.transcribe(snapPath, this.currentOptions);
          const partial = result.text ? result.text.trim() : "";
          if (partial && this.state === "recording" && partial !== this.lastPartialText) {
            this.lastPartialText = partial;
            this.notifyPartialListeners(partial);
          }
        }
      } catch {
        // Ignore partial cycle errors and continue recording
      } finally {
        if (existsSync(snapPath)) {
          await unlink(snapPath).catch(() => {});
        }
        this.isTranscribingPartial = false;
      }
    };

    // Trigger rolling partial recognition every 1200ms
    this.partialTimer = setInterval(runSnapshotCycle, 1200);
  }

  private clearPartialLoop(): void {
    if (this.partialTimer) {
      clearInterval(this.partialTimer);
      this.partialTimer = undefined;
    }
    this.isTranscribingPartial = false;
  }

  private notifyPartialListeners(text: string): void {
    for (const listener of this.partialListeners) {
      try {
        listener(text);
      } catch {
        // Ignore listener exceptions
      }
    }
  }

  private setState(newState: AudioRecordingState): void {
    if (this.state !== newState) {
      this.state = newState;
      for (const listener of this.listeners) {
        try {
          listener(newState);
        } catch {
          // Ignore listener exceptions
        }
      }
    }
  }

  private clearAutoStopTimer(): void {
    if (this.autoStopTimeout) {
      clearTimeout(this.autoStopTimeout);
      this.autoStopTimeout = undefined;
    }
  }
}
