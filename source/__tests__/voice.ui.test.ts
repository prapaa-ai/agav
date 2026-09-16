import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import { VoiceInputController, type AudioRecorder, type STTEngine } from "../voice/index.js";

vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: async () => {},
}));

type FakeStdout = NodeJS.WriteStream & { chunks: string[] };

const makeStdout = (): FakeStdout => {
  const emitter = new EventEmitter() as unknown as FakeStdout;
  emitter.chunks = [];
  emitter.isTTY = true;
  emitter.columns = 80;
  emitter.rows = 20;
  emitter.write = ((data: string) => {
    emitter.chunks.push(data);
    return true;
  }) as FakeStdout["write"];
  return emitter;
};

const makeStdin = (): NodeJS.ReadStream => {
  const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
  emitter.isTTY = true;
  emitter.setRawMode = (() => emitter) as NodeJS.ReadStream["setRawMode"];
  emitter.resume = (() => emitter) as NodeJS.ReadStream["resume"];
  emitter.pause = (() => emitter) as NodeJS.ReadStream["pause"];
  emitter.read = (() => null) as NodeJS.ReadStream["read"];
  return emitter;
};

const stripAnsi = (s: string): string =>
  s.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const settle = async (instance: { waitUntilRenderFlush: () => Promise<void> }) => {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await instance.waitUntilRenderFlush();
  }
};

describe("Voice UI Input Prompt Component", () => {
  let mockRecorder: AudioRecorder;
  let mockStt: STTEngine;
  let transcribePromiseResolve: ((val: any) => void) | null = null;
  let lastPromptValue = "";

  beforeEach(() => {
    VoiceInputController.resetInstance();
    lastPromptValue = "";

    mockRecorder = {
      state: "idle",
      start: vi.fn(async () => {
        (mockRecorder as any).state = "recording";
      }),
      stop: vi.fn(async () => {
        (mockRecorder as any).state = "idle";
        return { wavPath: "/mock/audio.wav", durationMs: 1200, sampleRate: 16000 };
      }),
      cancel: vi.fn(async () => {
        (mockRecorder as any).state = "idle";
      }),
      getState: vi.fn(() => (mockRecorder as any).state),
    } as any;

    mockStt = {
      transcribe: vi.fn(async () => {
        return {
          text: "hello world voice input",
          durationMs: 400,
          provider: "mock-whisper",
          model: "whisper-1",
        };
      }),
    };
  });

  afterEach(() => {
    VoiceInputController.resetInstance();
    vi.restoreAllMocks();
  });

  const mount = async (initialValue = "") => {
    const stdout = makeStdout();
    const stdin = makeStdin();

    const Host = () => {
      const [value, setValue] = useState(initialValue);
      lastPromptValue = value;
      return h(InputPrompt, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        keybindings: DEFAULT_KEYBINDINGS,
      });
    };

    const instance = render(h(Host), {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await settle(instance);
    return { instance, stdout, stdin };
  };

  it("renders idle mic badge by default", async () => {
    VoiceInputController.getInstance(mockRecorder, mockStt);
    const { instance, stdout } = await mount();

    const output = stripAnsi(stdout.chunks.join(""));
    expect(output).toContain("[Ctrl+B 🎤 Mic]");
    instance.unmount();
  });

  it("updates badge when controller starts recording", async () => {
    const controller = VoiceInputController.getInstance(mockRecorder, mockStt);
    const { instance, stdout } = await mount();

    await controller.start();
    await settle(instance);

    const output = stripAnsi(stdout.chunks.join(""));
    expect(output).toContain("● [Recording... Press Ctrl+B or Enter to finish]");
    instance.unmount();
  });

  it("updates badge to transcribing state during transcription", async () => {
    mockStt.transcribe = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          transcribePromiseResolve = resolve;
        }),
    );

    const controller = VoiceInputController.getInstance(mockRecorder, mockStt);
    const { instance, stdout } = await mount();

    await controller.start();
    await settle(instance);

    const stopPromise = controller.stop();
    await settle(instance);

    const transcribingOutput = stripAnsi(stdout.chunks.join(""));
    expect(transcribingOutput).toContain("⏳ [Transcribing speech locally...]");

    // Complete transcription
    transcribePromiseResolve!({
      text: "transcribed speech",
      durationMs: 300,
      provider: "mock",
      model: "mock-model",
    });
    await stopPromise;
    await settle(instance);

    const idleOutput = stripAnsi(stdout.chunks.join(""));
    expect(idleOutput).toContain("[Ctrl+B 🎤 Mic]");
    instance.unmount();
  });

  it("handles Ctrl+B hotkey to toggle voice input and inserts text in standard terminals", async () => {
    const controller = VoiceInputController.getInstance(mockRecorder, mockStt);
    const { instance, stdin } = await mount("");

    expect(controller.getState()).toBe("idle");

    // Press Ctrl+B (\x02) to start recording in any standard terminal
    stdin.emit("data", Buffer.from("\x02"));
    await settle(instance);

    expect(controller.getState()).toBe("recording");
    expect(mockRecorder.start).toHaveBeenCalled();

    // Press Ctrl+B (\x02) again to stop recording and transcribe
    stdin.emit("data", Buffer.from("\x02"));
    await settle(instance);

    expect(mockRecorder.stop).toHaveBeenCalled();
    expect(mockStt.transcribe).toHaveBeenCalled();
    expect(lastPromptValue).toBe("hello world voice input");
    instance.unmount();
  });

  it("handles Ctrl+M hotkey to toggle voice input in terminals with enhanced keyboard mode", async () => {
    const controller = VoiceInputController.getInstance(mockRecorder, mockStt);
    const { instance, stdin } = await mount("");

    expect(controller.getState()).toBe("idle");

    // Press Ctrl+M using xterm modifyOtherKeys / Kitty sequence: [27;5;109~
    stdin.emit("data", Buffer.from("\x1b[27;5;109~"));
    await settle(instance);

    expect(controller.getState()).toBe("recording");
    expect(mockRecorder.start).toHaveBeenCalled();

    // Press Ctrl+M again to stop recording and transcribe
    stdin.emit("data", Buffer.from("\x1b[27;5;109~"));
    await settle(instance);

    expect(mockRecorder.stop).toHaveBeenCalled();
    expect(mockStt.transcribe).toHaveBeenCalled();
    expect(lastPromptValue).toBe("hello world voice input");
    instance.unmount();
  });

  it("stops recording and inserts transcribed text when Enter is pressed during recording", async () => {
    const controller = VoiceInputController.getInstance(mockRecorder, mockStt);
    const { instance, stdin } = await mount("");

    // Type initial prompt text so caret is at the end
    for (const ch of "prompt: ") {
      stdin.emit("data", Buffer.from(ch));
      await settle(instance);
    }
    expect(lastPromptValue).toBe("prompt: ");

    await controller.start();
    await settle(instance);
    expect(controller.getState()).toBe("recording");

    // Press Enter to finish recording
    stdin.emit("data", Buffer.from("\r"));
    await settle(instance);

    expect(mockRecorder.stop).toHaveBeenCalled();
    expect(controller.getState()).toBe("idle");
    expect(lastPromptValue).toBe("prompt: hello world voice input");
    instance.unmount();
  });
});
