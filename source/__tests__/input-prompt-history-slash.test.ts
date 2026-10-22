import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

// Seed prompt history with slash commands. The bug: once Up-arrow recalls a
// slash command (e.g. "/status"), the command-suggestion dropdown opens and
// captured further Up/Down presses, so the user could no longer cycle past the
// recalled command through the rest of their history.
vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => ["hello world", "/status", "/model"],
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

let currentValue = "";

// A recalled slash command ("/status", "/model") only opens the suggestion
// dropdown when there are matching commands registered. Supply them so the
// dropdown actually appears and can contend for the arrow keys.
const COMMANDS = [
  { name: "status", description: "" },
  { name: "model", description: "" },
];

const Host = () => {
  const [value, setValue] = useState("");
  currentValue = value;
  return h(InputPrompt, {
    value,
    onChange: setValue,
    onSubmit: () => {},
    commands: COMMANDS,
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

const UP = Buffer.from("\x1b[A");
const DOWN = Buffer.from("\x1b[B");
const ESCAPE = Buffer.from("\x1b");
const BACKSPACE = Buffer.from("\x7f");

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

describe("InputPrompt history navigation past recalled slash commands", () => {
  it("keeps cycling history with Up after a slash command is recalled", async () => {
    const { instance, stdin } = await mount();

    // First Up recalls the most recent entry ("/model").
    await press(instance, stdin, UP);
    expect(currentValue).toBe("/model");

    // Second Up must keep walking back to "/status", not get stuck on the
    // command-suggestion dropdown opened by "/model".
    await press(instance, stdin, UP);
    expect(currentValue).toBe("/status");

    // Third Up reaches the oldest entry.
    await press(instance, stdin, UP);
    expect(currentValue).toBe("hello world");

    instance.unmount();
  });

  it("walks forward with Down through slash commands back to the draft", async () => {
    const { instance, stdin } = await mount();

    await press(instance, stdin, UP, 3);
    expect(currentValue).toBe("hello world");

    // Down must step forward through the slash-command entries.
    await press(instance, stdin, DOWN);
    expect(currentValue).toBe("/status");

    await press(instance, stdin, DOWN);
    expect(currentValue).toBe("/model");

    // One more Down restores the empty draft.
    await press(instance, stdin, DOWN);
    expect(currentValue).toBe("");

    instance.unmount();
  });
});

describe("InputPrompt ends history browsing on cancel or edit", () => {
  it("Escape then a fresh slash command navigates suggestions, not history", async () => {
    const { instance, stdin } = await mount();

    // Recall "/model", then Escape to clear it.
    await press(instance, stdin, UP);
    expect(currentValue).toBe("/model");
    await press(instance, stdin, ESCAPE);
    expect(currentValue).toBe("");

    // Typing "/" opens command suggestions on a fresh draft. Down must move
    // the suggestion selection, never restore the stale history draft.
    await type(instance, stdin, "/");
    await press(instance, stdin, DOWN);
    expect(currentValue).toBe("/");

    instance.unmount();
  });

  it("backspacing a recalled command leaves suggestion nav, not history", async () => {
    const { instance, stdin } = await mount();

    // Recall "/model", then backspace down to just "/".
    await press(instance, stdin, UP);
    expect(currentValue).toBe("/model");
    await press(instance, stdin, BACKSPACE, 5);
    expect(currentValue).toBe("/");

    // Down must drive the suggestion dropdown, not resume history browsing.
    await press(instance, stdin, DOWN);
    expect(currentValue).toBe("/");

    instance.unmount();
  });
});
