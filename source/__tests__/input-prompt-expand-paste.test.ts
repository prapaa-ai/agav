import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import { attachmentTileForId } from "../utils/attachments.js";

vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: async () => {},
}));

const ROWS = 20;
const COLS = 60;

const makeStdout = () => {
  const emitter = new EventEmitter() as unknown as NodeJS.WriteStream & { chunks: string[] };
  emitter.chunks = [];
  emitter.isTTY = true;
  emitter.columns = COLS;
  emitter.rows = ROWS;
  emitter.write = ((data: string) => {
    emitter.chunks.push(data);
    return true;
  }) as NodeJS.WriteStream["write"];
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    // eslint-disable-next-line no-await-in-loop
    await instance.waitUntilRenderFlush();
  }
};

let currentValue = "";
let expandFn: ((id: number, fullText: string) => boolean) | null = null;
let insertFn: ((label: string) => void) | null = null;

const Host = ({ initial }: { initial: string }) => {
  const [value, setValue] = useState(initial);
  currentValue = value;
  return h(InputPrompt, {
    value,
    onChange: setValue,
    onSubmit: () => {},
    keybindings: DEFAULT_KEYBINDINGS,
    onRegisterInsert: (fn) => { insertFn = fn; },
    onRegisterExpand: (fn) => { expandFn = fn; },
  });
};

const mount = async (initial = "") => {
  const stdout = makeStdout();
  const stdin = makeStdin();
  const instance = render(h(Host, { initial }), {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  });
  await settle(instance);
  return { instance, stdout, stdin };
};

describe("attachmentTileForId", () => {
  it("matches only the tile for the given id", () => {
    const text = "<<Pasted #1 · 5 chars, 1 lines>> and <<Pasted #2 · 9 chars, 1 lines>>";
    const re1 = attachmentTileForId(1);
    const re2 = attachmentTileForId(2);
    expect(text.match(re1)?.[0]).toBe("<<Pasted #1 · 5 chars, 1 lines>>");
    expect(text.match(re2)?.[0]).toBe("<<Pasted #2 · 9 chars, 1 lines>>");
  });

  it("does not match a different id, even a prefix of it", () => {
    const text = "<<Pasted #12 · 5 chars, 1 lines>>";
    expect(attachmentTileForId(1).test(text)).toBe(false);
    expect(attachmentTileForId(12).test(text)).toBe(true);
  });
});

describe("double-paste-to-expand wiring in InputPrompt", () => {
  it("replaces an existing tile with the full text via the registered expand function", async () => {
    const label = "<<Pasted #1 · 11 chars, 1 lines>>";
    const { instance } = await mount(`before ${label} after`);

    expect(expandFn).not.toBeNull();
    const fullText = "hello world";
    const replaced = expandFn!(1, fullText);
    await settle(instance);

    expect(replaced).toBe(true);
    expect(currentValue).toBe(`before ${fullText} after`);
    instance.unmount();
  });

  it("returns false and leaves the buffer untouched when the tile is no longer present", async () => {
    const { instance } = await mount("no attachments here");

    const replaced = expandFn!(1, "full text");
    await settle(instance);

    expect(replaced).toBe(false);
    expect(currentValue).toBe("no attachments here");
    instance.unmount();
  });

  it("expands the correct tile when several are present", async () => {
    const tile1 = "<<Pasted #1 · 3 chars, 1 lines>>";
    const tile2 = "<<Pasted #2 · 3 chars, 1 lines>>";
    const { instance } = await mount(`${tile1} and ${tile2}`);

    const replaced = expandFn!(2, "XYZ");
    await settle(instance);

    expect(replaced).toBe(true);
    expect(currentValue).toBe(`${tile1} and XYZ`);
    instance.unmount();
  });

  it("still allows inserting a fresh label afterward via onRegisterInsert", async () => {
    const { instance } = await mount("");
    insertFn!("<<Pasted #1 · 5 chars, 1 lines>>");
    await settle(instance);
    expect(currentValue).toContain("<<Pasted #1 · 5 chars, 1 lines>>");
    instance.unmount();
  });
});
