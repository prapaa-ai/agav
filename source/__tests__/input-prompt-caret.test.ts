import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, beforeAll, vi } from "vitest";
import chalk from "chalk";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

// The prompt persists history to `~/.agav` on submit. Stub it out: these tests
// press Enter, and the user's real history file is not ours to rewrite.
vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: async () => {},
}));

// `App` owns the prompt's text and rewrites it from several places — after a
// submit, after a `!` shell command, when a wizard exits — while `InputPrompt`
// owns the caret. Nothing reconciled the two, so a rewrite could leave the
// caret past the end of the buffer. That state is invisible and unrecoverable:
// no wrapped line claims an out-of-range caret, so the block cursor vanishes,
// and every backspace splices out characters that aren't there, so the key does
// nothing until the caret has walked back into the buffer one press at a time.

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
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    // eslint-disable-next-line no-await-in-loop
    await instance.waitUntilRenderFlush();
  }
};

/**
 * Stands in for `App`: owns the text, and exposes a way to rewrite it behind
 * the prompt's back the way the real clear-on-submit paths do.
 */
let clearFromParent: () => void = () => {};
let currentValue = "";

const Host = () => {
  const [value, setValue] = useState("");
  currentValue = value;
  clearFromParent = () => {
    setValue("");
  };
  return h(InputPrompt, {
    value,
    onChange: setValue,
    // `App` decides whether to clear on submit, and sometimes keeps the text —
    // a slash command it did not accept, a submit while a tool is confirming.
    // Keeping it here is the awkward case, so that is what this stands in for.
    onSubmit: () => {},
    keybindings: DEFAULT_KEYBINDINGS,
  });
};

const mount = async () => {
  const stdout = makeStdout();
  const stdin = makeStdin();
  const instance = render(h(Host), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle(instance);
  return { instance, stdout, stdin };
};

const type = async (
  instance: { waitUntilRenderFlush: () => Promise<void> },
  stdin: NodeJS.ReadStream,
  text: string,
) => {
  for (const ch of text) {
    stdin.emit("data", Buffer.from(ch));
    // eslint-disable-next-line no-await-in-loop
    await settle(instance);
  }
};

const BACKSPACE = Buffer.from("\x7f");
const ENTER = Buffer.from("\r");
const LEFT = Buffer.from("\x1b[D");

const press = async (
  instance: { waitUntilRenderFlush: () => Promise<void> },
  stdin: NodeJS.ReadStream,
  key: Buffer,
  times = 1,
) => {
  for (let i = 0; i < times; i++) {
    stdin.emit("data", key);
    // eslint-disable-next-line no-await-in-loop
    await settle(instance);
  }
};

/** True when the frame paints a block cursor (an inverse-video cell). */
const hasBlockCursor = (chunks: string[]): boolean => {
  const painted = chunks.filter((chunk) => /[a-z0-9]/i.test(stripAnsi(chunk)));
  return /\x1b\[7m/.test(painted.at(-1) ?? "");
};

describe("InputPrompt caret vs. a parent that rewrites the value", () => {
  // The block cursor is `<Text inverse>`, which is chalk — and chalk paints
  // nothing at all when it cannot detect a colour terminal, which it never can
  // under vitest. Force a level so the escape the assertion looks for is
  // actually emitted; without this the cursor test passes and fails for
  // reasons that have nothing to do with the caret.
  beforeAll(() => {
    chalk.level = 3;
  });

  it("keeps backspace working after the parent clears the text", async () => {
    const { instance, stdin } = await mount();

    await type(instance, stdin, "abcd");
    expect(currentValue).toBe("abcd");

    // The parent clears the buffer without telling the prompt — what every
    // clear-on-submit path in app.tsx does.
    clearFromParent();
    await settle(instance);
    expect(currentValue).toBe("");

    await type(instance, stdin, "abcd");
    expect(currentValue).toBe("abcd");

    // Four characters typed, so four backspaces must empty the buffer.
    for (let i = 0; i < 4; i++) {
      stdin.emit("data", BACKSPACE);
      // eslint-disable-next-line no-await-in-loop
      await settle(instance);
    }

    expect(currentValue).toBe("");
    instance.unmount();
  });

  it("keeps the block cursor on screen after the parent clears the text", async () => {
    const { instance, stdout, stdin } = await mount();

    await type(instance, stdin, "abcd");
    clearFromParent();
    await settle(instance);
    await type(instance, stdin, "abcd");

    expect(hasBlockCursor(stdout.chunks)).toBe(true);
    instance.unmount();
  });

  it("leaves the caret at the end of the retyped text, not past it", async () => {
    const { instance, stdin } = await mount();

    await type(instance, stdin, "abcd");
    clearFromParent();
    await settle(instance);
    await type(instance, stdin, "abcd");

    // Where the caret actually sits, asked without reading escape codes: step
    // left once and insert. From the end of "abcd" that lands between c and d.
    // A caret stranded past the end would insert at the tail instead.
    await press(instance, stdin, LEFT);
    await type(instance, stdin, "X");

    expect(currentValue).toBe("abcXd");
    instance.unmount();
  });

  it("keeps backspace working when the parent declines to clear on submit", async () => {
    const { instance, stdin } = await mount();

    await type(instance, stdin, "abcd");
    // The parent keeps the text. The caret must stay where the text is.
    await press(instance, stdin, ENTER);
    await settle(instance);
    expect(currentValue).toBe("abcd");

    await press(instance, stdin, BACKSPACE, 4);

    expect(currentValue).toBe("");
    instance.unmount();
  });
});

// The prompt's text belongs to `App`, so an edit is a round trip: `onChange`,
// the parent's setState, a re-render, and only then does the prop catch up.
// Keys do not wait for that. Under a long transcript — a resumed session — the
// commit takes longer than a keypress, so a burst of keys all read the same
// pre-burst prop and each computes the same answer from it. These tests emit a
// burst with no render flush in between, which is that window made reliable.
describe("InputPrompt keys arriving faster than a render commit", () => {
  /** Emits every key with no chance to re-render in between. */
  const burst = async (
    instance: { waitUntilRenderFlush: () => Promise<void> },
    stdin: NodeJS.ReadStream,
    keys: Buffer[],
  ) => {
    for (const key of keys) stdin.emit("data", key);
    await settle(instance);
  };

  it("registers every character of a burst of typing", async () => {
    const { instance, stdin } = await mount();

    await burst(instance, stdin, [..."abcd"].map((ch) => Buffer.from(ch)));

    expect(currentValue).toBe("abcd");
    instance.unmount();
  });

  it("deletes one character per backspace in a burst", async () => {
    const { instance, stdin } = await mount();

    await type(instance, stdin, "abcd");
    expect(currentValue).toBe("abcd");

    await burst(instance, stdin, Array.from({ length: 4 }, () => BACKSPACE));

    expect(currentValue).toBe("");
    instance.unmount();
  });

  it("deletes one character per backspace when they arrive in one read", async () => {
    // Holding backspace down: autorepeat fires faster than the event loop
    // reads, so several DELs land in a single chunk. They used to reach the
    // prompt as text and be inserted — four invisible delete characters, and a
    // buffer that took eight presses to clear.
    const { instance, stdin } = await mount();

    await type(instance, stdin, "abcd");
    stdin.emit("data", Buffer.from("\x7f\x7f\x7f\x7f"));
    await settle(instance);

    expect(currentValue).toBe("");
    instance.unmount();
  });

  it("moves once per arrow key when they arrive in one read", async () => {
    const { instance, stdin } = await mount();

    await type(instance, stdin, "wxyz");
    stdin.emit("data", Buffer.from("\x1b[D\x1b[D"));
    await settle(instance);
    await type(instance, stdin, "Q");

    expect(currentValue).toBe("wxQyz");
    instance.unmount();
  });

  it("keeps a burst of arrow keys and typing in step", async () => {
    const { instance, stdin } = await mount();

    await type(instance, stdin, "abcd");
    // Two lefts then an insert: the caret is at 2, so "X" lands between b and c.
    await burst(instance, stdin, [LEFT, LEFT, Buffer.from("X")]);

    expect(currentValue).toBe("abXcd");
    instance.unmount();
  });
});

const FORWARD_DELETE = Buffer.from("\x1b[3~");

describe("InputPrompt forward delete", () => {
  it("deletes the character after the cursor", async () => {
    const { instance, stdin } = await mount();
    await type(instance, stdin, "abcd");
    // Move cursor left twice: cursor is now before 'c'
    await press(instance, stdin, LEFT, 2);
    // Forward Delete should remove 'c'
    await press(instance, stdin, FORWARD_DELETE, 1);
    expect(currentValue).toBe("abd");
    instance.unmount();
  });

  it("does nothing at the end of the text", async () => {
    const { instance, stdin } = await mount();
    await type(instance, stdin, "abc");
    // Cursor is at the end — Forward Delete should be a no-op
    await press(instance, stdin, FORWARD_DELETE, 1);
    expect(currentValue).toBe("abc");
    instance.unmount();
  });
});

describe("InputPrompt Home/End keys", () => {
  it("Home key does not corrupt the input", async () => {
    const { instance, stdin } = await mount();
    await type(instance, stdin, "hello");
    // Home key (xterm: \x1b[H) — currently not handled, should be a no-op
    await press(instance, stdin, Buffer.from("\x1b[H"), 1);
    // Value should be unchanged
    expect(currentValue).toBe("hello");
    instance.unmount();
  });

  it("End key does not corrupt the input", async () => {
    const { instance, stdin } = await mount();
    await type(instance, stdin, "hello");
    await press(instance, stdin, LEFT, 3);
    // End key (xterm: \x1b[F) — currently not handled, should be a no-op
    await press(instance, stdin, Buffer.from("\x1b[F"), 1);
    // Value should be unchanged
    expect(currentValue).toBe("hello");
    instance.unmount();
  });
});
