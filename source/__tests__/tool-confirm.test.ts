import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ink/termio/clipboard.js", () => ({
  writeClipboard: vi.fn(),
}));

import { writeClipboard } from "../ink/termio/clipboard.js";
import Ink from "../ink/ink.js";
import ToolConfirm from "../components/tool-confirm.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import stringWidth from "string-width";

const writeClipboardMock = vi.mocked(writeClipboard);
const prefixWidth = stringWidth("Feedback for agent: ");

function findNodeWithHandler(node: any, handlerName: string): any {
  if (node && typeof node[handlerName] === "function") return node;
  for (const child of node?.childNodes ?? []) {
    const found = findNodeWithHandler(child, handlerName);
    if (found) return found;
  }
  return null;
}

async function mount(props: Partial<Parameters<typeof ToolConfirm>[0]> = {}) {
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (text: string) => { chunks.push(text); return true; },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => null,
  }) as unknown as NodeJS.ReadStream;

  const onConfirm = vi.fn();
  const instance = new Ink({
    stdout,
    stdin,
    stderr: stdout,
    patchConsole: false,
    exitOnCtrlC: false,
    alternateScreen: false,
    maxFps: 30,
  });

  instance.render(
    h(ToolConfirm, {
      toolName: "write_file",
      input: { path: "test.txt", content: "data" },
      onConfirm,
      keybindings: DEFAULT_KEYBINDINGS,
      ...props,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  await instance.waitUntilRenderFlush();

  const stripAnsi = (text: string) => text.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const getFrame = () => {
    const frames = chunks.filter((chunk) => /[a-z0-9]/i.test(stripAnsi(chunk)));
    return stripAnsi(frames.at(-1) ?? "");
  };

  return { instance, stdin, stdout, onConfirm, getFrame };
}

describe("ToolConfirm UI", () => {
  beforeEach(() => {
    writeClipboardMock.mockClear();
  });

  it("approves on 'y'", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "y");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("yes");
    } finally {
      instance.unmount();
    }
  });

  it("denies immediately on 'n' without entering feedback mode", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "n");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("no");
    } finally {
      instance.unmount();
    }
  });

  it("approves always on 'a'", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "a");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("always");
    } finally {
      instance.unmount();
    }
  });

  it("enters feedback mode on 'd', accepts text, and submits denial with feedback on Enter", async () => {
    const { instance, stdin, onConfirm, getFrame } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getFrame()).toContain("Feedback for agent");

      stdin.emit("data", "use existing utilities");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "use existing utilities",
      });
    } finally {
      instance.unmount();
    }
  });

  it("treats empty or whitespace-only feedback on Enter as plain 'no'", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "   ");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("no");
    } finally {
      instance.unmount();
    }
  });

  it("cancels feedback mode on Escape without resolving, returning to main prompt", async () => {
    const { instance, stdin, onConfirm, getFrame } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getFrame()).toContain("Feedback for agent");

      stdin.emit("data", "aborted feedback");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Press Escape to cancel feedback mode
      stdin.emit("data", "\x1b");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await instance.waitUntilRenderFlush();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(getFrame()).not.toContain("Feedback for agent");

      // Now pressing 'y' should approve
      stdin.emit("data", "y");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onConfirm).toHaveBeenCalledWith("yes");
    } finally {
      instance.unmount();
    }
  });

  it("handles backspace key while typing feedback", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "abc");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\x7f"); // Backspace
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "ab",
      });
    } finally {
      instance.unmount();
    }
  });

  it("displays the max length hint in feedback mode", async () => {
    const { instance, stdin, getFrame } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getFrame()).toContain("max 500 characters");
    } finally {
      instance.unmount();
    }
  });

  it("supports navigating cursor with left/right arrows and inserting mid-text", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "ac");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x1b[D"); // Left arrow
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "b");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "abc",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports home and end keys for cursor navigation", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "world");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x1b[H"); // Home
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "hello ");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x1b[F"); // End
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "!");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "hello world!",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports forward delete key", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "axb");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x1b[D"); // Left arrow past 'b'
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x1b[D"); // Left arrow past 'x'
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x1b[3~"); // Forward Delete 'x'
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "ab",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports text selection with shift+left and replacing selection by typing", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "hello world");
      await new Promise((resolve) => setTimeout(resolve, 30));
      for (let i = 0; i < 5; i++) {
        stdin.emit("data", "\x1b[1;2D"); // Shift+Left
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      stdin.emit("data", "there");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "hello there",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports deleting selection with backspace", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "delete this");
      await new Promise((resolve) => setTimeout(resolve, 30));
      for (let i = 0; i < 4; i++) {
        stdin.emit("data", "\x1b[1;2D"); // Shift+Left over "this"
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      stdin.emit("data", "\x7f"); // Backspace
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "delete",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports deleteWordBackward (Ctrl+W)", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "foo bar baz");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x17"); // Ctrl+W
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "foo bar",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports clearInput (Ctrl+U)", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "mistake text");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x15"); // Ctrl+U
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "correct");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "correct",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports copying selection with Ctrl+C and cutting selection with Ctrl+X", async () => {
    const { instance, stdin, stdout, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "copy me");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Select all with Ctrl+A
      stdin.emit("data", "\x01");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Copy with Ctrl+C
      stdin.emit("data", "\x03");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(writeClipboardMock).toHaveBeenCalledWith(stdout, "copy me");

      // Cut with Ctrl+X
      stdin.emit("data", "\x18");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(writeClipboardMock).toHaveBeenLastCalledWith(stdout, "copy me");

      // Type replacement and submit
      stdin.emit("data", "new text");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "new text",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports bracketed paste, inserting at cursor", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "prefix ");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\x1b[200~pasted payload\x1b[201~");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "prefix pasted payload",
      });
    } finally {
      instance.unmount();
    }
  });

  it("supports bracketed paste replacing an active selection", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "hello world");
      await new Promise((resolve) => setTimeout(resolve, 30));

      for (let i = 0; i < 5; i++) {
        stdin.emit("data", "\x1b[1;2D"); // Shift+Left over "world"
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      stdin.emit("data", "\x1b[200~there\x1b[201~");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "hello there",
      });
    } finally {
      instance.unmount();
    }
  });

  it("handles rapid typing and submission in the same tick without stale state", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      // Send 'd', text, and enter rapidly without waiting for render flush between them
      stdin.emit("data", "d");
      stdin.emit("data", "rapid message");
      stdin.emit("data", "\r");

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "rapid message",
      });
    } finally {
      instance.unmount();
    }
  });

  it("handles rapid cursor movement and editing before commit", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      stdin.emit("data", "ac");
      stdin.emit("data", "\x1b[D"); // Left arrow
      stdin.emit("data", "b");
      stdin.emit("data", "\r");

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "abc",
      });
    } finally {
      instance.unmount();
    }
  });

  it("enforces grapheme limit at 500 and allows replacement over selection when full", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));

      const hand = "👋🏽"; // 1 grapheme cluster (4 UTF-16 code units)
      // Type 500 composite graphemes
      stdin.emit("data", hand.repeat(500));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Attempt to type a 501st grapheme — should be rejected
      stdin.emit("data", "!");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Select the last 3 hands using Shift+Left
      for (let i = 0; i < 3; i++) {
        stdin.emit("data", "\x1b[1;2D");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Replace selection with "🎉" (1 grapheme)
      stdin.emit("data", "🎉");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: `${hand.repeat(497)}🎉`,
      });
    } finally {
      instance.unmount();
    }
  });

  it("handles pasting beyond remaining capacity in the middle of text", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "prefix suffix");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Move caret 6 positions left (to between "prefix " and "suffix")
      for (let i = 0; i < 6; i++) {
        stdin.emit("data", "\x1b[D");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Paste 600 characters; only 500 - 13 = 487 should fit
      stdin.emit("data", `\x1b[200~${"x".repeat(600)}\x1b[201~`);
      await new Promise((resolve) => setTimeout(resolve, 50));

      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: `prefix ${"x".repeat(487)}suffix`,
      });
    } finally {
      instance.unmount();
    }
  });

  it("handles composite emoji, grapheme clusters, and navigation/deletion", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Composite emoji (family + skin tone + acute e + single char)
      const family = "👨‍👩‍👧‍👦";
      const wavingHand = "👋🏽";
      const acuteE = "e\u0301";
      stdin.emit("data", `${family}${wavingHand}${acuteE}x`);
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Left arrow past 'x'
      stdin.emit("data", "\x1b[D");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Left arrow past acuteE
      stdin.emit("data", "\x1b[D");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Backspace deletes wavingHand
      stdin.emit("data", "\x7f");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: `${family}${acuteE}x`,
      });
    } finally {
      instance.unmount();
    }
  });

  it("positions caret on single mouse click and inserts at click position", async () => {
    const { instance, stdin, stdout, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "hello world");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await instance.waitUntilRenderFlush();

      const lineNode = findNodeWithHandler((instance as any).rootNode, "onMouseDown");
      expect(lineNode).toBeDefined();

      // Click at offset 6 (before "world")
      const clickX = (lineNode.internal_x ?? 0) + prefixWidth + 6;
      lineNode.onMouseDown({ x: clickX, y: 0, button: 0 });
      lineNode.onMouseUp({ x: clickX, y: 0, button: 0 });
      lineNode.onClick({ x: clickX, y: 0, button: 0 });

      // Single click must NOT copy to clipboard
      expect(writeClipboardMock).not.toHaveBeenCalled();

      // Insert at the new caret position
      stdin.emit("data", "brave ");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "hello brave world",
      });
    } finally {
      instance.unmount();
    }
  });

  it("selects text on mouse drag and copies on mouse-up", async () => {
    const { instance, stdin, stdout, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "alpha beta gamma");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await instance.waitUntilRenderFlush();

      const lineNode = findNodeWithHandler((instance as any).rootNode, "onMouseDown");
      expect(lineNode).toBeDefined();

      // Drag across "beta" (offsets 6 to 10)
      const startX = (lineNode.internal_x ?? 0) + prefixWidth + 6;
      const endX = (lineNode.internal_x ?? 0) + prefixWidth + 10;
      lineNode.onMouseDown({ x: startX, y: 0, button: 0 });
      lineNode.onMouseMove({ x: endX, y: 0, button: 0 });
      lineNode.onMouseUp({ x: endX, y: 0, button: 0 });

      // Mouse-up on drag selection copies to clipboard
      expect(writeClipboardMock).toHaveBeenCalledWith(stdout, "beta");

      // Typing replaces the drag selection
      stdin.emit("data", "delta");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "alpha delta gamma",
      });
    } finally {
      instance.unmount();
    }
  });

  it("selects word on double-click and copies on mouse-up", async () => {
    const { instance, stdin, stdout, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "one two three");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await instance.waitUntilRenderFlush();

      const lineNode = findNodeWithHandler((instance as any).rootNode, "onMouseDown");
      expect(lineNode).toBeDefined();

      // Double-click within "two" (offset 5)
      const clickX = (lineNode.internal_x ?? 0) + prefixWidth + 5;
      lineNode.onMouseDown({ x: clickX, y: 0, button: 0 });
      lineNode.onMouseDown({ x: clickX, y: 0, button: 0 });
      lineNode.onMouseUp({ x: clickX, y: 0, button: 0 });

      expect(writeClipboardMock).toHaveBeenCalledWith(stdout, "two");

      // Backspace deletes the double-clicked word selection
      stdin.emit("data", "\x7f");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "one  three",
      });
    } finally {
      instance.unmount();
    }
  });

  it("selects all text on triple-click and copies on mouse-up", async () => {
    const { instance, stdin, stdout, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "all of this");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await instance.waitUntilRenderFlush();

      const lineNode = findNodeWithHandler((instance as any).rootNode, "onMouseDown");
      expect(lineNode).toBeDefined();

      // Triple-click selects the full buffer
      const clickX = (lineNode.internal_x ?? 0) + prefixWidth + 3;
      lineNode.onMouseDown({ x: clickX, y: 0, button: 0 });
      lineNode.onMouseDown({ x: clickX, y: 0, button: 0 });
      lineNode.onMouseDown({ x: clickX, y: 0, button: 0 });
      lineNode.onMouseUp({ x: clickX, y: 0, button: 0 });

      expect(writeClipboardMock).toHaveBeenCalledWith(stdout, "all of this");

      // Typing replaces entire text
      stdin.emit("data", "replacement");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "replacement",
      });
    } finally {
      instance.unmount();
    }
  });

  it("clears selection on single click without deleting text", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "first second");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await instance.waitUntilRenderFlush();

      const lineNode = findNodeWithHandler((instance as any).rootNode, "onMouseDown");
      expect(lineNode).toBeDefined();

      // Double-click on "first" (offset 2)
      const firstX = (lineNode.internal_x ?? 0) + prefixWidth + 2;
      lineNode.onMouseDown({ x: firstX, y: 0, button: 0 });
      lineNode.onMouseDown({ x: firstX, y: 0, button: 0 });
      lineNode.onMouseUp({ x: firstX, y: 0, button: 0 });

      // Wait past the multi-click threshold (400ms) so the subsequent click is a fresh single-click
      await new Promise((resolve) => setTimeout(resolve, 450));

      // Now single-click at the end of the text (offset 12)
      const endX = (lineNode.internal_x ?? 0) + prefixWidth + 12;
      lineNode.onMouseDown({ x: endX, y: 0, button: 0 });
      lineNode.onMouseUp({ x: endX, y: 0, button: 0 });
      lineNode.onClick({ x: endX, y: 0, button: 0 });

      // Type text: "first" must NOT be deleted because selection was cleared
      stdin.emit("data", " third");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "first second third",
      });
    } finally {
      instance.unmount();
    }
  });

  it("does not show [D]eny with feedback or enter feedback mode for background-job prompts", async () => {
    // Construct a minimal input that satisfies parseBackgroundConfirmInput():
    // action must be a string, spec must have cwd (string), isolation (truthy),
    // and invocation (shell mode requires commandText string).
    const backgroundInput = {
      action: "start",
      spec: {
        invocation: { mode: "shell", commandText: "echo hi", interpreter: "cmd" },
        cwd: process.cwd(),
        isolation: { backend: "none", required: false },
        env: {},
        credentialRefs: [],
        ownershipScope: "unverified",
        limits: {},
        headless: false,
      },
    };
    const { instance, stdin, onConfirm, getFrame } = await mount({
      toolName: "run_background_job",
      input: backgroundInput,
    });
    try {
      const frame = getFrame();
      // The [D]eny with feedback option must not appear on background prompts
      expect(frame).not.toContain("[D]");
      expect(frame).not.toContain("Deny with feedback");

      // Pressing 'd' must not enter feedback mode
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await instance.waitUntilRenderFlush();
      expect(getFrame()).not.toContain("Feedback for agent");
      expect(onConfirm).not.toHaveBeenCalled();

      // 'n' must still resolve with "no"
      stdin.emit("data", "n");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("no");
    } finally {
      instance.unmount();
    }
  });
});
