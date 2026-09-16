import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  NativeAudioRecorder,
  WhisperSTTEngine,
  VoiceInputController,
  type AudioRecorder,
  type AudioRecordingResult,
  type STTEngine,
  type STTResult,
} from "../voice/index.js";

// Helper to create mock ChildProcess
function createMockChildProcess(): ChildProcess & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn> };
} {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    write: vi.fn(),
  };
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true;
    setTimeout(() => proc.emit("close", 0), 10);
    return true;
  });
  return proc;
}

describe("Voice Input System", () => {
  let testTempDir: string;

  beforeEach(async () => {
    testTempDir = join(tmpdir(), `agav_voice_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await mkdir(testTempDir, { recursive: true });
    VoiceInputController.resetInstance();
  });

  afterEach(async () => {
    VoiceInputController.resetInstance();
    if (existsSync(testTempDir)) {
      await rm(testTempDir, { recursive: true, force: true }).catch(() => {});
    }
    vi.restoreAllMocks();
  });

  describe("NativeAudioRecorder", () => {
    it("starts in idle state and throws when stop is called while idle", async () => {
      const recorder = new NativeAudioRecorder({ tempDir: testTempDir });
      expect(recorder.getState()).toBe("idle");
      await expect(recorder.stop()).rejects.toThrow("Audio recorder is not recording");
    });

    it("cancel is a safe no-op when idle", async () => {
      const recorder = new NativeAudioRecorder({ tempDir: testTempDir });
      await expect(recorder.cancel()).resolves.toBeUndefined();
      expect(recorder.getState()).toBe("idle");
    });

    it("handles Windows recording lifecycle and state transitions", async () => {
      let spawnedChild: ReturnType<typeof createMockChildProcess> | null = null;
      const mockSpawn = vi.fn((_cmd, _args) => {
        spawnedChild = createMockChildProcess();
        // Simulate PowerShell emitting RECORDING_STARTED
        setTimeout(() => {
          spawnedChild?.stdout.emit("data", Buffer.from("RECORDING_STARTED\n"));
        }, 10);
        return spawnedChild as any;
      });

      const recorder = new NativeAudioRecorder({
        tempDir: testTempDir,
        platform: "win32",
        spawnProcess: mockSpawn as any,
      });

      expect(recorder.getState()).toBe("idle");
      const startPromise = recorder.start();
      await startPromise;

      expect(recorder.getState()).toBe("recording");
      expect(mockSpawn).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      );

      // Attempting to start again while recording should throw
      await expect(recorder.start()).rejects.toThrow("Audio recorder is already recording");

      // Setup simulated stop response
      if (spawnedChild) {
        (spawnedChild as any).stdin.write.mockImplementation((input: string) => {
          if (input.startsWith("SAVE ")) {
            const destPath = input.substring(5).trim();
            // Create dummy WAV file so stop() can stat it
            writeFile(destPath, Buffer.from("RIFF1234WAVEfmt ")).then(() => {
              spawnedChild?.stdout.emit("data", Buffer.from("RECORDING_STOPPED\n"));
              spawnedChild?.emit("close", 0);
            });
          }
        });
      }

      const result = await recorder.stop();
      expect(result.wavPath).toContain(".wav");
      expect(result.sampleRate).toBe(16000);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(recorder.getState()).toBe("idle");
    });

    it("handles cancellation during recording and cleans up temp file", async () => {
      let spawnedChild: ReturnType<typeof createMockChildProcess> | null = null;
      const mockSpawn = vi.fn(() => {
        spawnedChild = createMockChildProcess();
        setTimeout(() => {
          spawnedChild?.stdout.emit("data", Buffer.from("RECORDING_STARTED\n"));
        }, 10);
        return spawnedChild as any;
      });

      const recorder = new NativeAudioRecorder({
        tempDir: testTempDir,
        platform: "win32",
        spawnProcess: mockSpawn as any,
      });

      await recorder.start();
      expect(recorder.getState()).toBe("recording");

      await recorder.cancel();
      expect(recorder.getState()).toBe("idle");
      expect((spawnedChild as any)?.stdin.write).toHaveBeenCalledWith("CANCEL\n");
    });

    it("handles Linux recording with arecord", async () => {
      let spawnedChild: ReturnType<typeof createMockChildProcess> | null = null;
      const mockSpawn = vi.fn((cmd, args) => {
        spawnedChild = createMockChildProcess();
        // create the wav file
        const wavPath = args[args.length - 1];
        setTimeout(() => {
          writeFile(wavPath, Buffer.from("RIFF_LINUX_WAV"));
        }, 10);
        return spawnedChild as any;
      });

      const recorder = new NativeAudioRecorder({
        tempDir: testTempDir,
        platform: "linux",
        spawnProcess: mockSpawn as any,
      });

      await recorder.start();
      expect(recorder.getState()).toBe("recording");
      expect(mockSpawn).toHaveBeenCalledWith(
        "arecord",
        expect.arrayContaining(["-D", "default", "-f", "S16_LE", "-r", "16000", "-c", "1"]),
      );

      const stopPromise = recorder.stop();
      setTimeout(() => {
        spawnedChild?.emit("close", 0);
      }, 20);

      const result = await stopPromise;
      expect(result.wavPath).toContain(".wav");
      expect(recorder.getState()).toBe("idle");
    });

    it("handles macOS recording with sox and fallback to rec", async () => {
      let callCount = 0;
      const mockSpawn = vi.fn((cmd, args) => {
        callCount++;
        const child = createMockChildProcess();
        if (cmd === "sox") {
          // Simulate sox not found (ENOENT)
          setTimeout(() => {
            const err: any = new Error("Command not found");
            err.code = "ENOENT";
            child.emit("error", err);
          }, 10);
        } else if (cmd === "rec") {
          const wavPath = args[args.length - 1];
          setTimeout(() => {
            writeFile(wavPath, Buffer.from("RIFF_MAC_REC"));
          }, 20);
        }
        return child as any;
      });

      const recorder = new NativeAudioRecorder({
        tempDir: testTempDir,
        platform: "darwin",
        spawnProcess: mockSpawn as any,
      });

      await recorder.start();
      expect(recorder.getState()).toBe("recording");
      expect(callCount).toBe(2); // First sox, then rec fallback
      await recorder.cancel();
      expect(recorder.getState()).toBe("idle");
    });

    it("transitions to error state when process fails on startup", async () => {
      const mockSpawn = vi.fn(() => {
        const child = createMockChildProcess();
        setTimeout(() => {
          child.emit("error", new Error("Spawn failure"));
        }, 10);
        return child as any;
      });

      const recorder = new NativeAudioRecorder({
        tempDir: testTempDir,
        platform: "win32",
        spawnProcess: mockSpawn as any,
      });

      await expect(recorder.start()).rejects.toThrow("Failed to start PowerShell recording process");
      expect(recorder.getState()).toBe("error");
    });
  });

  describe("WhisperSTTEngine", () => {
    it("transcribes using Groq Whisper API", async () => {
      const dummyWavPath = join(testTempDir, "sample.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF1234WAVEDATA"));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "  Hello from Groq Whisper!  " }),
      });

      const engine = new WhisperSTTEngine({
        fetchFn: mockFetch as any,
        loadConfigFn: async () => ({} as any),
      });

      const result = await engine.transcribe(dummyWavPath, {
        provider: "groq",
        apiKey: "gsk_test_key_123",
        language: "en",
        prompt: "Agav assistant",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, requestInit] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
      expect(requestInit.method).toBe("POST");
      expect(requestInit.headers["Authorization"]).toBe("Bearer gsk_test_key_123");

      const body = requestInit.body as FormData;
      expect(body.get("model")).toBe("whisper-large-v3-turbo");
      expect(body.get("language")).toBe("en");
      expect(body.get("prompt")).toBe("Agav assistant");
      expect(body.get("file")).toBeDefined();

      expect(result).toEqual({
        text: "Hello from Groq Whisper!",
        durationMs: expect.any(Number),
        provider: "groq",
        model: "whisper-large-v3-turbo",
      });
    });

    it("transcribes using OpenAI Whisper API", async () => {
      const dummyWavPath = join(testTempDir, "sample.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF1234WAVEDATA"));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "Transcribed with OpenAI Whisper" }),
      });

      const engine = new WhisperSTTEngine({
        fetchFn: mockFetch as any,
        loadConfigFn: async () =>
          ({
            openaiApiKey: "sk-openai-config-key",
          }) as any,
      });

      const result = await engine.transcribe(dummyWavPath, {
        provider: "openai",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, requestInit] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(requestInit.headers["Authorization"]).toBe("Bearer sk-openai-config-key");

      const body = requestInit.body as FormData;
      expect(body.get("model")).toBe("whisper-1");

      expect(result).toEqual({
        text: "Transcribed with OpenAI Whisper",
        durationMs: expect.any(Number),
        provider: "openai",
        model: "whisper-1",
      });
    });

    it("auto-detects Groq when API key starts with gsk_", async () => {
      const dummyWavPath = join(testTempDir, "sample.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF1234WAVEDATA"));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "Auto-detected Groq" }),
      });

      const engine = new WhisperSTTEngine({
        fetchFn: mockFetch as any,
        loadConfigFn: async () => ({} as any),
      });

      const result = await engine.transcribe(dummyWavPath, {
        apiKey: "gsk_live_key_999",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("whisper-large-v3-turbo");
    });

    it("throws helpful error if no API key is available", async () => {
      const dummyWavPath = join(testTempDir, "sample.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF1234WAVEDATA"));

      const oldGroq = process.env.GROQ_API_KEY;
      const oldOpenai = process.env.OPENAI_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const engine = new WhisperSTTEngine({
          fetchFn: vi.fn() as any,
          loadConfigFn: async () => ({} as any),
          localEngine: {
            isAvailable: async () => false,
          } as any,
        });

        await expect(engine.transcribe(dummyWavPath)).rejects.toThrow(
          "No API key found for Whisper transcription. Please set GROQ_API_KEY or OPENAI_API_KEY in your environment or ~/.agav/config.json.",
        );
      } finally {
        if (oldGroq) process.env.GROQ_API_KEY = oldGroq;
        if (oldOpenai) process.env.OPENAI_API_KEY = oldOpenai;
      }
    });

    it("uses local Whisper when available and no provider is specified", async () => {
      const dummyWavPath = join(testTempDir, "sample.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF1234WAVEDATA"));

      const mockLocalEngine = {
        isAvailable: vi.fn().mockResolvedValue(true),
        transcribe: vi.fn().mockResolvedValue({
          text: "Transcribed locally",
          durationMs: 50,
          provider: "local",
          model: "local-whisper",
        }),
      };

      const engine = new WhisperSTTEngine({
        fetchFn: vi.fn() as any,
        loadConfigFn: async () => ({} as any),
        localEngine: mockLocalEngine as any,
      });

      const result = await engine.transcribe(dummyWavPath);
      expect(mockLocalEngine.isAvailable).toHaveBeenCalledTimes(1);
      expect(mockLocalEngine.transcribe).toHaveBeenCalledWith(dummyWavPath, undefined);
      expect(result.text).toBe("Transcribed locally");
      expect(result.provider).toBe("local");
    });

    it("handles API error responses with clear message", async () => {
      const dummyWavPath = join(testTempDir, "sample.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF1234WAVEDATA"));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({
          error: { message: "Invalid Groq API key provided." },
        }),
      });

      const engine = new WhisperSTTEngine({
        fetchFn: mockFetch as any,
        loadConfigFn: async () => ({} as any),
      });

      await expect(
        engine.transcribe(dummyWavPath, {
          provider: "groq",
          apiKey: "invalid_key",
        }),
      ).rejects.toThrow("Whisper transcription failed (groq, HTTP 401): Invalid Groq API key provided.");
    });

    it("handles network connection failures", async () => {
      const dummyWavPath = join(testTempDir, "sample.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF1234WAVEDATA"));

      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const engine = new WhisperSTTEngine({
        fetchFn: mockFetch as any,
        loadConfigFn: async () => ({} as any),
      });

      await expect(
        engine.transcribe(dummyWavPath, {
          provider: "groq",
          apiKey: "gsk_test",
        }),
      ).rejects.toThrow("Failed to connect to Whisper API (groq at https://api.groq.com/openai/v1/audio/transcriptions): ECONNREFUSED");
    });
  });

  describe("VoiceInputController", () => {
    it("manages singleton instance and resets cleanly", () => {
      const instance1 = VoiceInputController.getInstance();
      const instance2 = VoiceInputController.getInstance();
      expect(instance1).toBe(instance2);

      VoiceInputController.resetInstance();
      const instance3 = VoiceInputController.getInstance();
      expect(instance3).not.toBe(instance1);
    });

    it("orchestrates start -> stop -> transcription lifecycle and cleans up recording file", async () => {
      const dummyWavPath = join(testTempDir, "controller_test.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF_AUDIO_DATA"));

      let recorderState = "idle";
      const mockRecorder: AudioRecorder = {
        start: vi.fn(async () => {
          recorderState = "recording";
        }),
        stop: vi.fn(async (): Promise<AudioRecordingResult> => {
          recorderState = "idle";
          return {
            wavPath: dummyWavPath,
            durationMs: 1200,
            sampleRate: 16000,
          };
        }),
        cancel: vi.fn(async () => {
          recorderState = "idle";
        }),
        getState: vi.fn(() => recorderState as any),
      };

      const mockSTTEngine: STTEngine = {
        transcribe: vi.fn(async (): Promise<STTResult> => {
          return {
            text: "Voice input controller success!",
            durationMs: 300,
            provider: "groq",
            model: "whisper-large-v3-turbo",
          };
        }),
      };

      const controller = new VoiceInputController(mockRecorder, mockSTTEngine);
      const stateTransitions: string[] = [];
      const unsubscribe = controller.onStateChange((state) => {
        stateTransitions.push(state);
      });

      expect(controller.getState()).toBe("idle");
      await controller.start({ provider: "groq", apiKey: "gsk_test" });
      expect(controller.getState()).toBe("recording");
      expect(mockRecorder.start).toHaveBeenCalledTimes(1);

      const text = await controller.stop();
      expect(text).toBe("Voice input controller success!");
      expect(controller.getState()).toBe("idle");
      expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
      expect(mockSTTEngine.transcribe).toHaveBeenCalledWith(dummyWavPath, {
        provider: "groq",
        apiKey: "gsk_test",
      });

      // Verify temp file was cleaned up by controller
      expect(existsSync(dummyWavPath)).toBe(false);

      // Verify observed state transitions: recording -> transcribing -> idle
      expect(stateTransitions).toEqual(["recording", "transcribing", "idle"]);

      unsubscribe();
      // Test that unsubscribed listener receives no more updates
      await controller.start();
      expect(stateTransitions.length).toBe(3);
      await controller.cancel();
    });

    it("throws when stopping while not recording", async () => {
      const controller = new VoiceInputController({} as any, {} as any);
      await expect(controller.stop()).rejects.toThrow("Voice input is not recording");
    });

    it("throws when starting while already active", async () => {
      const mockRecorder: AudioRecorder = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue({ wavPath: "", durationMs: 0, sampleRate: 16000 }),
        cancel: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue("recording"),
      };
      const controller = new VoiceInputController(mockRecorder, {} as any);
      await controller.start();
      await expect(controller.start()).rejects.toThrow("Voice input is already active");
    });

    it("handles cancel cleanly", async () => {
      const mockRecorder: AudioRecorder = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue({ wavPath: "", durationMs: 0, sampleRate: 16000 }),
        cancel: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue("idle"),
      };
      const controller = new VoiceInputController(mockRecorder, {} as any);
      await controller.start();
      expect(controller.getState()).toBe("recording");

      await controller.cancel();
      expect(controller.getState()).toBe("idle");
      expect(mockRecorder.cancel).toHaveBeenCalledTimes(1);
    });

    it("handles transcription failure and sets state to error", async () => {
      const dummyWavPath = join(testTempDir, "error_test.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF_DATA"));

      const mockRecorder: AudioRecorder = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue({
          wavPath: dummyWavPath,
          durationMs: 500,
          sampleRate: 16000,
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue("idle"),
      };

      const mockSTTEngine: STTEngine = {
        transcribe: vi.fn().mockRejectedValue(new Error("Transcription failed")),
      };

      const controller = new VoiceInputController(mockRecorder, mockSTTEngine);
      await controller.start();

      await expect(controller.stop()).rejects.toThrow("Transcription failed");
      expect(controller.getState()).toBe("error");
      // Cleaned up file even on error
      expect(existsSync(dummyWavPath)).toBe(false);
    });

    it("triggers auto-stop when maxDurationMs is exceeded", async () => {
      const dummyWavPath = join(testTempDir, "auto_stop.wav");
      await writeFile(dummyWavPath, Buffer.from("RIFF_DATA"));

      const mockRecorder: AudioRecorder = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue({
          wavPath: dummyWavPath,
          durationMs: 50,
          sampleRate: 16000,
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue("idle"),
      };

      const mockSTTEngine: STTEngine = {
        transcribe: vi.fn().mockResolvedValue({
          text: "Auto stopped",
          durationMs: 10,
          provider: "groq",
          model: "whisper-large-v3-turbo",
        }),
      };

      const controller = new VoiceInputController(mockRecorder, mockSTTEngine);
      await controller.start({ maxDurationMs: 40 });
      expect(controller.getState()).toBe("recording");

      // Wait for auto-stop timeout
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(mockRecorder.stop).toHaveBeenCalled();
      expect(controller.getState()).toBe("idle");
    });
  });
});
