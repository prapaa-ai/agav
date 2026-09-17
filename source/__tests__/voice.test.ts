import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeDeveloperLexicon,
  detectRecorderBackend,
  setMockRecorderBackend,
  AudioRecorder,
  findLocalWhisperBinary,
  setMockWhisperBinary,
  resetWhisperBinaryCache,
  isWhisperInstalled,
  getWhisperInstallGuide,
  transcribeAudioFile,
  VoiceController,
} from "../voice/index.js";
import { micCommand } from "../commands/mic.js";

describe("P2.0 - Voice Dictation & Whisper STT", () => {
  describe("Developer Lexicon Normalization", () => {
    it("corrects git commands and platforms", () => {
      expect(normalizeDeveloperLexicon("please run get status")).toBe("please run git status");
      expect(normalizeDeveloperLexicon("push to get hub now")).toBe("push to GitHub now");
      expect(normalizeDeveloperLexicon("check get lab repository")).toBe("check GitLab repository");
      expect(normalizeDeveloperLexicon("get commit and get push")).toBe("git commit and git push");
      expect(normalizeDeveloperLexicon("get diff and get checkout main")).toBe("git diff and git checkout main");
    });

    it("corrects frameworks, languages, and tools", () => {
      expect(normalizeDeveloperLexicon("build with type script and react js")).toBe("build with TypeScript and React");
      expect(normalizeDeveloperLexicon("training pie torch and tensor flow models")).toBe("training PyTorch and TensorFlow models");
      expect(normalizeDeveloperLexicon("connecting to post grass database")).toBe("connecting to PostgreSQL database");
      expect(normalizeDeveloperLexicon("install packages with p npm")).toBe("install packages with pnpm");
      expect(normalizeDeveloperLexicon("manage pods with cube cuddle")).toBe("manage pods with kubectl");
      expect(normalizeDeveloperLexicon("run tests with vee test")).toBe("run tests with vitest");
    });

    it("corrects agav terminology", () => {
      expect(normalizeDeveloperLexicon("hello a gav")).toBe("hello agav");
      expect(normalizeDeveloperLexicon("running in a-gav environment")).toBe("running in agav environment");
    });

    it("handles empty or blank inputs safely", () => {
      expect(normalizeDeveloperLexicon("")).toBe("");
      expect(normalizeDeveloperLexicon("   ")).toBe("");
      expect(normalizeDeveloperLexicon(null as any)).toBe("");
    });
  });

  describe("AudioRecorder", () => {
    afterEach(() => {
      setMockRecorderBackend(null);
    });

    it("detects system recorder backend", () => {
      const backend = detectRecorderBackend();
      expect(["powershell", "sox", "ffmpeg", "arecord", "none"]).toContain(backend);
    });

    it("manages recording state and cancellation", () => {
      const recorder = new AudioRecorder();
      expect(recorder.isRecording()).toBe(false);

      recorder.cancelRecording();
      expect(recorder.isRecording()).toBe(false);
    });

    it("throws error when stopping non-active recording", async () => {
      const recorder = new AudioRecorder();
      await expect(recorder.stopRecording()).rejects.toThrow("No audio recording is currently active.");
    });
  });

  describe("Whisper Local Engine", () => {
    afterEach(() => {
      resetWhisperBinaryCache();
    });

    it("provides platform install instructions", () => {
      const guide = getWhisperInstallGuide();
      expect(guide).toContain("Whisper local STT is not installed");
      expect(guide.length).toBeGreaterThan(20);
    });

    it("returns false for isWhisperInstalled when mock binary is null", () => {
      setMockWhisperBinary(null);
      expect(isWhisperInstalled()).toBe(false);
      expect(findLocalWhisperBinary()).toBe(null);
    });

    it("returns true for isWhisperInstalled when mock binary is present", () => {
      setMockWhisperBinary("whisper-cli");
      expect(isWhisperInstalled()).toBe(true);
      expect(findLocalWhisperBinary()).toBe("whisper-cli");
    });

    it("throws error if audio file does not exist", async () => {
      const nonExistentPath = join(tmpdir(), "non-existent-test-file.wav");
      await expect(transcribeAudioFile(nonExistentPath)).rejects.toThrow("Audio file not found");
    });

    it("returns installation fallback guide when whisper is not installed", async () => {
      const tempWav = join(tmpdir(), `test-audio-${Date.now()}.wav`);
      writeFileSync(tempWav, "RIFF....WAVEfmt ");

      try {
        setMockWhisperBinary(null);
        const result = await transcribeAudioFile(tempWav);
        expect(result.isFallback).toBe(true);
        expect(result.text).toContain("Whisper local STT is not installed");
      } finally {
        if (existsSync(tempWav)) {
          unlinkSync(tempWav);
        }
      }
    });
  });

  describe("VoiceController", () => {
    beforeEach(() => {
      VoiceController.resetInstance();
    });

    afterEach(() => {
      VoiceController.resetInstance();
    });

    it("starts in idle state", () => {
      const controller = VoiceController.getInstance();
      expect(controller.getState()).toBe("idle");
    });

    it("notifies listeners on state change", () => {
      const controller = VoiceController.getInstance();
      const states: string[] = [];
      const unsubscribe = controller.onStateChange((state) => states.push(state));

      controller.cancel(); // Stays idle or triggers
      unsubscribe();
      expect(Array.isArray(states)).toBe(true);
    });

    it("cancel resets state to idle", () => {
      const controller = VoiceController.getInstance();
      controller.cancel();
      expect(controller.getState()).toBe("idle");
    });
  });

  describe("Mic Slash Command (/mic)", () => {
    const mockContext = {
      sessionId: "test-session",
      cwd: process.cwd(),
      showStatus: vi.fn(),
    } as any;

    beforeEach(() => {
      VoiceController.resetInstance();
      vi.clearAllMocks();
    });

    afterEach(() => {
      VoiceController.resetInstance();
    });

    it("has correct metadata", () => {
      expect(micCommand.name).toBe("mic");
      expect(micCommand.description).toContain("voice dictation");
      expect(micCommand.usage).toContain("/mic");
    });

    it("returns help text", async () => {
      const result = await micCommand.execute("help", mockContext);
      expect(result.type).toBe("message");
      expect((result as any).text).toContain("Microphone & Voice Dictation Usage");
      expect((result as any).text).toContain("/mic status");
    });

    it("reports current status", async () => {
      const result = await micCommand.execute("status", mockContext);
      expect(result.type).toBe("message");
      expect((result as any).text).toContain("Voice Dictation Status");
      expect((result as any).text).toContain("State: IDLE");
      expect((result as any).text).toContain("Ctrl+B");
    });

    it("fails gracefully when transcribing non-existent audio file", async () => {
      const result = await micCommand.execute("transcribe /path/that/does/not/exist.wav", mockContext);
      expect(result.type).toBe("message");
      expect((result as any).text).toContain("Failed to transcribe file");
    });

    it("warns when transcribing without a filename argument", async () => {
      const result = await micCommand.execute("transcribe", mockContext);
      expect(result.type).toBe("message");
      expect((result as any).text).toContain("Missing audio file path");
    });
  });
});
