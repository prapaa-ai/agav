import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: async () => {},
}));

const makeStdout = (): NodeJS.WriteStream => {
  const emitter = new EventEmitter() as unknown as NodeJS.WriteStream;
  emitter.isTTY = true;
  emitter.columns = 80;
  emitter.rows = 20;
  emitter.write = (() => true) as NodeJS.WriteStream["write"];
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

const TILE_1 = "<<Pasted #1 · 100 chars, 2 lines>>";
const TILE_2 = "<<Image #2 · 800x600>>";

describe("InputPrompt attachment removal by ID", () => {
  it("removes the first attachment by ID on Backspace immediately after its tile", async () => {
    let latestValue = `${TILE_2} `;
    let latestAttachments = [
      { id: 1, label: TILE_1 },
      { id: 2, label: TILE_2 },
    ];
    const removedIds: Array<number | undefined> = [];
    let insertAtCaret: ((text: string) => void) | null = null;

    const Host = () => {
      const [value, setValue] = useState(latestValue);
      const [attachments, setAttachments] = useState(latestAttachments);
      latestValue = value;
      latestAttachments = attachments;
      return h(InputPrompt, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        onRegisterInsert: (fn) => {
          insertAtCaret = fn;
        },
        onRemoveAttachment: (id?: number) => {
          removedIds.push(id);
          setAttachments((prev) => (id !== undefined ? prev.filter((a) => a.id !== id) : prev.slice(0, -1)));
        },
        keybindings: DEFAULT_KEYBINDINGS,
      });
    };

    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), { stdout, stdin, exitOnCtrlC: false });
    await settle(instance);

    try {
      // Caret starts at 0 (before TILE_2). Insert TILE_1 at caret so caret sits right after TILE_1 + space.
      insertAtCaret!(TILE_1);
      await settle(instance);

      // Backspace removes TILE_1 and attachment #1, leaving only TILE_2 and attachment #2.
      stdin.emit("data", Buffer.from("\x7f"));
      await settle(instance);

      expect(removedIds).toEqual([1]);
      expect(latestValue).toBe(`${TILE_2} `);
      expect(latestAttachments).toEqual([{ id: 2, label: TILE_2 }]);
    } finally {
      instance.unmount();
    }
  });

  it("removes the entire tile and matching attachment by ID on forward Delete before a tile", async () => {
    let latestValue = `${TILE_1} ${TILE_2}`;
    let latestAttachments = [
      { id: 1, label: TILE_1 },
      { id: 2, label: TILE_2 },
    ];
    const removedIds: Array<number | undefined> = [];

    const Host = () => {
      const [value, setValue] = useState(latestValue);
      const [attachments, setAttachments] = useState(latestAttachments);
      latestValue = value;
      latestAttachments = attachments;
      return h(InputPrompt, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        onRemoveAttachment: (id?: number) => {
          removedIds.push(id);
          setAttachments((prev) => (id !== undefined ? prev.filter((a) => a.id !== id) : prev.slice(0, -1)));
        },
        keybindings: DEFAULT_KEYBINDINGS,
      });
    };

    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), { stdout, stdin, exitOnCtrlC: false });
    await settle(instance);

    try {
      // Move caret to position 0 (immediately before TILE_1) using Home (Ctrl+A).
      stdin.emit("data", "\x01");
      await settle(instance);

      // Forward Delete removes TILE_1 and attachment #1.
      stdin.emit("data", "\x1b[3~");
      await settle(instance);

      expect(removedIds).toEqual([1]);
      expect(latestValue).toBe(TILE_2);
      expect(latestAttachments).toEqual([{ id: 2, label: TILE_2 }]);
    } finally {
      instance.unmount();
    }
  });

  it("leaves ordinary text deletion unchanged", async () => {
    let latestValue = "abc";
    const onRemoveAttachment = vi.fn();

    const Host = () => {
      const [value, setValue] = useState(latestValue);
      latestValue = value;
      return h(InputPrompt, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        onRemoveAttachment,
        keybindings: DEFAULT_KEYBINDINGS,
      });
    };

    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(Host), { stdout, stdin, exitOnCtrlC: false });
    await settle(instance);

    try {
      // Move caret to end of "abc" (3 Right arrows).
      for (let i = 0; i < 3; i++) {
        stdin.emit("data", Buffer.from("\x1b[C"));
      }
      await settle(instance);
      stdin.emit("data", Buffer.from("\x7f"));
      await settle(instance);
      expect(latestValue).toBe("ab");
      expect(onRemoveAttachment).not.toHaveBeenCalled();

      stdin.emit("data", Buffer.from("\x1b[D"));
      await settle(instance);
      stdin.emit("data", Buffer.from("\x1b[3~"));
      await settle(instance);
      expect(latestValue).toBe("a");
      expect(onRemoveAttachment).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });
});
