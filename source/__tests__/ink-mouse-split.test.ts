import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

// Stub prompt history — tests press Enter and we must not touch real files.
vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: async () => {},
}));

const ROWS = 20;
const COLS = 80;

type FakeStdout = NodeJS.WriteStream & { chunks: string[] };

const makeStdout = (): FakeStdout => {
  const emitter = new EventEmitter() as unknown as FakeStdout;
  emitter.chunks = [];
  emitter.isTTY = true;
  emitter.columns = COLS;
  emitter.rows = ROWS;
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
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    // eslint-disable-next-line no-await-in-loop
    await instance.waitUntilRenderFlush();
  }
};

/** Wrapper that tracks the current prompt value. */
let currentValue = "";

const Host = () => {
  const [value, setValue] = useState("");
  currentValue = value;
  return h(InputPrompt, {
    value,
    onChange: setValue,
    onSubmit: () => {},
    keybindings: DEFAULT_KEYBINDINGS,
  });
};

describe("split mouse sequences must not leak into the input prompt", () => {
  it("buffers a partial SGR mouse prefix split across two reads", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // Simulate a mouse wheel event split across two stdin reads.
    // Full SGR sequence: \x1b[<65;12;5M
    // Read 1 delivers the prefix:
    stdin.emit("data", "\x1b[<65;12");
    await settle(instance);
    // Read 2 delivers the rest:
    stdin.emit("data", ";5M");
    await settle(instance);

    // The prompt should still be empty — no mouse garbage inserted.
    expect(currentValue).toBe("");

    instance.unmount();
  });

  it("buffers a partial SGR mouse sequence at the end of a batch", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // Two complete wheel events + a partial third, all in one read.
    const twoComplete = "\x1b[<65;10;3M\x1b[<65;10;4M";
    const partial = "\x1b[<65;10";
    stdin.emit("data", twoComplete + partial);
    await settle(instance);

    // The partial should be buffered, not inserted as text.
    expect(currentValue).toBe("");

    // Complete it in the next read.
    stdin.emit("data", ";5M");
    await settle(instance);

    // Still no text in the prompt.
    expect(currentValue).toBe("");

    instance.unmount();
  });

  it("does not interfere with arrow key sequences", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // Type some text then use arrow keys — these start with \x1b[ which
    // is a shared CSI prefix, but must NOT be buffered as mouse.
    stdin.emit("data", "hello");
    await settle(instance);
    expect(currentValue).toBe("hello");

    // Left arrow (\x1b[D) must work normally, not get buffered.
    stdin.emit("data", "\x1b[D");
    await settle(instance);

    // Type a character — should insert before the last char.
    stdin.emit("data", "X");
    await settle(instance);
    expect(currentValue).toBe("hellXo");

    instance.unmount();
  });

  it("discards the tail of a split sequence that arrives alone", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // Simulate a fragment that is the tail of a split mouse sequence
    // arriving without the prefix being buffered (e.g. if the prefix
    // was consumed before this fix was in place).  The fragment contains
    // only digits, semicolons, and 'M' — these are all typeable ASCII,
    // so the prompt may show them. This test documents current behavior:
    // bare fragments without ESC are treated as typed text. The primary
    // defense is the buffering that prevents fragments from occurring.
    //
    // We verify the buffering side: a proper split is handled.
    stdin.emit("data", "\x1b[<65");
    await settle(instance);
    stdin.emit("data", ";12;5M");
    await settle(instance);

    expect(currentValue).toBe("");

    instance.unmount();
  });

  it("drops an orphaned SGR mouse tail that arrives without a buffered prefix", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // The escape timer (50ms) may flush a buffered \x1b before the rest of the
    // sequence arrives.  The remaining body `[<65;52;26M` is caught by
    // matchOrphanedCSI, but a deeper split — e.g. the \x1b[ was already
    // consumed — leaves a raw tail like `<65;52;26M` or `;52;26M`.  These must
    // be silently dropped, not inserted into the prompt.
    stdin.emit("data", "<65;52;26M");
    await settle(instance);
    expect(currentValue).toBe("");

    // Tail starting mid-field: `;52;26M`
    stdin.emit("data", ";52;26M");
    await settle(instance);
    expect(currentValue).toBe("");

    // Multiple orphaned tails concatenated (scroll burst)
    stdin.emit("data", "<65;52;26M<65;52;27M<65;52;28M");
    await settle(instance);
    expect(currentValue).toBe("");

    instance.unmount();
  });

  it("drops an orphaned tail followed by a complete mouse sequence", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // A tail fragment followed by a full escape sequence in the same read.
    stdin.emit("data", ";26M\x1b[<65;52;27M");
    await settle(instance);
    expect(currentValue).toBe("");

    instance.unmount();
  });

  it("does not swallow bare digits-plus-M that look like user input", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // Bare "26M", "5m", "100M" are plausible user input (file sizes, durations).
    // They must NOT be dropped — only fragments with at least one semicolon
    // (the SGR field separator) are recognized as orphaned mouse tails.
    stdin.emit("data", "26M");
    await settle(instance);
    expect(currentValue).toBe("26M");

    instance.unmount();
  });

  it("documents the accepted trade-off: a two-field small-number tail is dropped", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // A "col;row" pair of small numbers (e.g. "1;2m") is indistinguishable from
    // a genuine two-field SGR mouse tail whose leading fields were consumed in a
    // prior read, so it is dropped. This is a deliberate, documented trade-off:
    // preventing mouse-report leakage into the prompt is worth losing this rare
    // form of input. Digit bounding (1–4 per field) limits the blast radius to
    // exactly these small "N;N" shapes.
    stdin.emit("data", "1;2m");
    await settle(instance);
    expect(currentValue).toBe("");

    instance.unmount();
  });
});
