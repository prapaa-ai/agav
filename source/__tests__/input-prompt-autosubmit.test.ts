import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

// Argument-less commands flagged `autoSubmit` should run the moment they are
// chosen from the suggestion dropdown (Tab or Enter) instead of completing to
// `/name ` and waiting for a second keypress. Commands that take arguments must
// still complete-and-wait.

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

const COMMANDS = [
  { name: "customize", description: "Customize appearance", autoSubmit: true },
  { name: "name", description: "Name the session", argumentHint: "<title>" },
];

let currentValue = "";
const submitted: string[] = [];

const Host = () => {
  const [value, setValue] = useState("");
  currentValue = value;
  return h(InputPrompt, {
    value,
    onChange: setValue,
    onSubmit: (v: string) => submitted.push(v),
    commands: COMMANDS,
    keybindings: DEFAULT_KEYBINDINGS,
  });
};

const mount = async () => {
  submitted.length = 0;
  currentValue = "";
  const stdout = makeStdout();
  const stdin = makeStdin();
  const instance = render(h(Host), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle(instance);
  return { instance, stdin };
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

const press = async (
  instance: { waitUntilRenderFlush: () => Promise<void> },
  stdin: NodeJS.ReadStream,
  key: Buffer,
) => {
  stdin.emit("data", key);
  await settle(instance);
};

const TAB = Buffer.from("\t");
const ENTER = Buffer.from("\r");

describe("InputPrompt auto-submit for argument-less commands", () => {
  it("runs an autoSubmit command when selected with Tab", async () => {
    const { instance, stdin } = await mount();
    // Partial match so the dropdown shows customize as the selected row.
    await type(instance, stdin, "/cust");
    await press(instance, stdin, TAB);
    expect(submitted).toEqual(["/customize"]);
    instance.unmount();
  });

  it("runs an autoSubmit command when selected with Enter", async () => {
    const { instance, stdin } = await mount();
    await type(instance, stdin, "/cust");
    await press(instance, stdin, ENTER);
    expect(submitted).toEqual(["/customize"]);
    instance.unmount();
  });

  it("completes (does not auto-run) a command that takes arguments", async () => {
    const { instance, stdin } = await mount();
    await type(instance, stdin, "/nam");
    await press(instance, stdin, TAB);
    // Tab completes to `/name ` and waits; nothing is submitted.
    expect(submitted).toEqual([]);
    expect(currentValue).toBe("/name ");
    instance.unmount();
  });
});
