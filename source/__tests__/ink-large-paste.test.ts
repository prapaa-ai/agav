import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, it, expect } from "vitest";
import render from "../ink/render.js";
import { Text, usePaste, useInput } from "../ink/index.js";

// Some terminals (notably the buggy node-pty bundled by Cursor/VS Code) open a
// bracketed-paste frame — ESC[200~ plus the first chunk — for a large paste and
// then never send the closing ESC[201~. Without a fallback the TUI buffers every
// subsequent keystroke into the never-ending paste and appears frozen; the only
// way out is to kill the process. A watchdog must flush the orphaned frame so
// input delivery recovers, and a well-formed large paste streaming over several
// reads must still be captured whole.

const ROWS = 20;
const COLS = 80;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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

const settle = async (instance: { waitUntilRenderFlush: () => Promise<void> }) => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    // eslint-disable-next-line no-await-in-loop
    await instance.waitUntilRenderFlush();
  }
};

let pastes: string[] = [];
let typed = "";

const Host = () => {
  usePaste((text) => { pastes.push(text); });
  useInput((input) => { typed += input; });
  return h(Text, null, "ready");
};

const reset = () => {
  pastes = [];
  typed = "";
};

describe("bracketed paste with dropped or mangled markers", () => {
  it("flushes an orphaned paste frame so the TUI does not hang forever", async () => {
    reset();
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // A paste frame that opens but — like Cursor's truncating PTY — never closes.
    const body = "a".repeat(1500);
    stdin.emit("data", PASTE_START + body);

    // Nothing is delivered yet: we are still waiting on the (never-arriving)
    // end marker.
    await settle(instance);
    expect(pastes).toEqual([]);

    // After the watchdog window the buffered content is flushed as a paste.
    await new Promise((resolve) => { setTimeout(resolve, 1200); });
    await settle(instance);
    expect(pastes).toEqual([body]);

    // Input delivery has recovered: a subsequent keystroke is delivered as
    // input instead of being swallowed by the stuck paste frame.
    stdin.emit("data", "x");
    await settle(instance);
    expect(typed).toBe("x");

    instance.unmount();
  });

  it("captures a well-formed large paste spanning multiple reads whole", async () => {
    reset();
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // Deliver a single paste split across three reads, with each read arriving
    // comfortably inside the watchdog window so the frame is never cut short.
    const part1 = "a".repeat(1000);
    const part2 = "b".repeat(1000);
    const part3 = "c".repeat(1000);
    stdin.emit("data", PASTE_START + part1);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    stdin.emit("data", part2);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    stdin.emit("data", part3 + PASTE_END);
    await settle(instance);

    expect(pastes).toEqual([part1 + part2 + part3]);

    instance.unmount();
  });

  it("delivers a complete single-chunk paste immediately without waiting", async () => {
    reset();
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    const body = "hello pasted world";
    stdin.emit("data", PASTE_START + body + PASTE_END);
    await settle(instance);

    expect(pastes).toEqual([body]);

    instance.unmount();
  });

  it("still tokenizes an escape sequence that follows plain text in one read", async () => {
    reset();
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // "hello", then a left arrow, then "X" — all in separate reads. The bulk
    // plain-run drain must stop at the ESC so the arrow is parsed, not inserted.
    stdin.emit("data", "hello");
    await settle(instance);
    expect(typed).toBe("hello");

    reset();
    stdin.emit("data", "\x1b[D");
    await settle(instance);
    // A left arrow is not printable text, so nothing is appended.
    expect(typed).toBe("");

    stdin.emit("data", "X");
    await settle(instance);
    expect(typed).toBe("X");

    instance.unmount();
  });

  it("discards a stray end marker (full and ESC-stripped) instead of leaking it", async () => {
    reset();
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // A paste-end marker with no frame open — its matching start was dropped
    // upstream — must not surface as `[201~` in the prompt.
    stdin.emit("data", "\x1b[201~");
    await settle(instance);
    expect(typed).toBe("");
    expect(pastes).toEqual([]);

    // The same marker with its leading ESC stripped.
    stdin.emit("data", "[201~");
    await settle(instance);
    expect(typed).toBe("");
    expect(pastes).toEqual([]);

    instance.unmount();
  });

  it("recovers the reported case: body leaked as input then a bare [201~ tail", async () => {
    reset();
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // Upstream dropped the ESC[200~ start, so the body arrives as plain input
    // and ends with a bare (ESC-stripped) `[201~` terminator. The text must be
    // delivered as input, but the terminator must be stripped, not inserted.
    const body = "  >>> eval step 67000: val_loss 3.1151 ppl 22.54";
    stdin.emit("data", body + "[201~");
    await settle(instance);
    expect(typed).toBe(body);

    instance.unmount();
  });

  it("opens a frame from an ESC-stripped start marker", async () => {
    reset();
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    // Start marker arrives without its ESC; the body should still be captured
    // as a paste (closed here by a proper ESC[201~).
    const body = "pasted via mangled start";
    stdin.emit("data", "[200~" + body + PASTE_END);
    await settle(instance);
    expect(pastes).toEqual([body]);
    expect(typed).toBe("");

    instance.unmount();
  });

  it("reassembles an end marker split across the ~1 KiB PTY read boundary", async () => {
    // This is the exact shape captured from Cursor's terminal: node-pty caps a
    // read at ~1022 bytes, so a large paste's first read ends with `ESC[200~`
    // + body + a truncated `ESC[2`, and the next read delivers the rest of the
    // terminator `01~`. The end marker therefore straddles the buffer boundary;
    // searching only the newly arrived chunk would never match it and the frame
    // would hang open forever.
    reset();
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);

    const body = "a".repeat(1016); // body + markers lands the split inside ESC[201~
    const full = PASTE_START + body + PASTE_END;
    // Split so the first chunk ends with the truncated "\x1b[2" of the end marker.
    const splitAt = full.indexOf(PASTE_END) + 3; // after "\x1b[2"
    const chunk1 = full.slice(0, splitAt);
    const chunk2 = full.slice(splitAt);
    expect(chunk1.endsWith("\x1b[2")).toBe(true);
    expect(chunk2).toBe("01~");

    stdin.emit("data", chunk1);
    await settle(instance);
    // End marker not yet complete — paste must not have fired, nothing leaked.
    expect(pastes).toEqual([]);
    expect(typed).toBe("");

    stdin.emit("data", chunk2);
    await settle(instance);
    // Terminator completed across the boundary: the paste fires exactly once
    // with the clean body, and no `[201~` leaks.
    expect(pastes).toEqual([body]);
    expect(typed).toBe("");

    // Input delivery continues normally afterward.
    stdin.emit("data", "x");
    await settle(instance);
    expect(typed).toBe("x");

    instance.unmount();
  });
});
