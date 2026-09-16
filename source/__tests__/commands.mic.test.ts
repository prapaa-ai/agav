import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { micCommand } from "../commands/mic.js";
import { VoiceInputController, type AudioRecorder, type STTEngine } from "../voice/index.js";
import type { CommandContext } from "../commands/types.js";

describe("/mic slash command", () => {
  let mockRecorder: AudioRecorder;
  let mockStt: STTEngine;
  let mockContext: CommandContext;

  beforeEach(() => {
    VoiceInputController.resetInstance();

    mockRecorder = {
      state: "idle",
      start: vi.fn(async () => {
        (mockRecorder as any).state = "recording";
      }),
      stop: vi.fn(async () => {
        (mockRecorder as any).state = "idle";
        return { wavPath: "/mock/audio.wav", durationMs: 1500, sampleRate: 16000 };
      }),
      cancel: vi.fn(async () => {
        (mockRecorder as any).state = "idle";
      }),
      getState: vi.fn(() => (mockRecorder as any).state),
    } as any;

    mockStt = {
      transcribe: vi.fn(async () => {
        return {
          text: "testing mic slash command",
          durationMs: 300,
          provider: "local-whisper",
          model: "whisper-1",
        };
      }),
    };

    mockContext = {
      config: {} as any,
    } as CommandContext;

    VoiceInputController.getInstance(mockRecorder, mockStt);
  });

  afterEach(() => {
    VoiceInputController.resetInstance();
    vi.restoreAllMocks();
  });

  it("defines metadata matching requirements", () => {
    expect(micCommand.name).toBe("mic");
    expect(micCommand.description).toBe("Toggle local speech-to-text microphone voice input");
    expect(micCommand.usage).toContain("Usage: /mic [start|stop|status|config]");
    expect(micCommand.usage).toContain("Controls Agav's native local Whisper voice input.");
  });

  it("handles 'status' argument and displays engine details", async () => {
    const result = await micCommand.execute("status", mockContext);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("Local Whisper Voice Engine Status:");
      expect(result.text).toContain("Binary Path / Audio Driver");
      expect(result.text).toContain("Model Path / Name");
      expect(result.text).toContain("Engine Availability");
      expect(result.text).toContain("Status: idle");
    }
  });

  it("handles 'config' argument", async () => {
    const result = await micCommand.execute("config", mockContext);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("Local Whisper Configuration:");
      expect(result.text).toContain("Environment Variables: LOCAL_WHISPER_URL");
    }
  });

  it("handles 'start' argument to start voice recording", async () => {
    const result = await micCommand.execute("start", mockContext);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("Voice input started");
    }
    expect(mockRecorder.start).toHaveBeenCalled();

    // Calling start again informs user that it is already active
    const secondResult = await micCommand.execute("start", mockContext);
    if (secondResult.type === "message") {
      expect(secondResult.text).toContain("already active");
    }
  });

  it("handles 'stop' argument when not recording", async () => {
    const result = await micCommand.execute("stop", mockContext);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("not currently recording");
    }
  });

  it("handles 'stop' argument after recording started", async () => {
    await micCommand.execute("start", mockContext);
    const result = await micCommand.execute("stop", mockContext);

    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("Transcription: testing mic slash command");
    }
    expect(mockRecorder.stop).toHaveBeenCalled();
    expect(mockStt.transcribe).toHaveBeenCalled();
  });

  it("handles toggle when called without arguments", async () => {
    const startResult = await micCommand.execute("", mockContext);
    if (startResult.type === "message") {
      expect(startResult.text).toContain("Voice input started");
    }
    expect(mockRecorder.start).toHaveBeenCalledTimes(1);

    const stopResult = await micCommand.execute("", mockContext);
    if (stopResult.type === "message") {
      expect(stopResult.text).toContain("Transcription: testing mic slash command");
    }
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  });

  it("handles unknown arguments by showing usage", async () => {
    const result = await micCommand.execute("unknown-arg", mockContext);
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain('Unknown argument: "unknown-arg"');
      expect(result.text).toContain(micCommand.usage);
    }
  });
});
