import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

// Slash commands that expose an inline `argumentHint` should surface it as
// dimmed "ghost" guidance: on the composer line once the command is fully named
// (e.g. "/name <title>"), and beside the selected row in the dropdown.

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

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// The latest painted frame, ANSI-stripped. Ink repaints the whole frame on each
// flush; the last non-trivial chunk holds the current on-screen state, so later
// assertions see live content rather than accumulated intermediate frames.
const frame = (stdout: FakeStdout): string => {
  for (let i = stdout.chunks.length - 1; i >= 0; i--) {
    const painted = stdout.chunks[i]!.replace(ANSI, "");
    if (painted.includes("❯")) return painted;
  }
  return stdout.chunks.join("").replace(ANSI, "");
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
  { name: "name", description: "Name the current session", argumentHint: "<title>" },
  { name: "nap", description: "A command with no argument hint" },
  { name: "status", description: "Show status" },
];

const Host = () => {
  const [value, setValue] = useState("");
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
  return { instance, stdin, stdout };
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

describe("InputPrompt slash-command argument hints", () => {
  it("shows the dropdown argument hint beside the selected command", async () => {
    const { instance, stdin, stdout } = await mount();
    stdout.chunks.length = 0;
    await type(instance, stdin, "/name");
    // The selected row carries its inline argument placeholder.
    expect(frame(stdout)).toContain("<title>");
    instance.unmount();
  });

  it("shows the inline ghost hint once a command is fully named", async () => {
    const { instance, stdin, stdout } = await mount();
    // Typing the full name plus a trailing space resolves to exactly one
    // command and paints the ghost placeholder on the composer line.
    stdout.chunks.length = 0;
    await type(instance, stdin, "/name ");
    expect(frame(stdout)).toContain("<title>");
    instance.unmount();
  });

  it("omits the hint for commands that declare none", async () => {
    const { instance, stdin, stdout } = await mount();
    stdout.chunks.length = 0;
    await type(instance, stdin, "/nap ");
    expect(frame(stdout)).not.toContain("<title>");
    instance.unmount();
  });
});
