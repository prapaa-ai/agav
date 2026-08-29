import { EventEmitter } from "node:events";
import { createElement as h, useEffect, useRef, useState } from "react";
import { describe, it, expect } from "vitest";
import render from "../ink/render.js";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { measureElement } from "../ink/measure-element.js";
import MessageList from "../components/message-list.js";
import type { DisplayMessage } from "../components/message-list.js";
import type { DOMElement, WheelEventData } from "../ink/index.js";

// The earlier viewport test drove ScrollBox with bare <Box>/<Text> children,
// which is not what the app does: every row goes through <MessageBubble>, a
// function component. ScrollBox used to size its children by walking the
// element tree, and a component element carries no `children` prop — so every
// message measured 0 rows, the scroll range collapsed to nothing and the wheel
// was a no-op while the transcript overflowed its viewport. These tests mount
// the real MessageList so that class of regression cannot come back.

const ROWS = 20;
const COLS = 100;

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

/** The last chunk that actually carried text, as plain rows. */
const lastFrame = (chunks: string[]): string[] => {
  const painted = chunks.filter((chunk) => /[a-z0-9]/i.test(stripAnsi(chunk)));
  return stripAnsi(painted.at(-1) ?? "").split("\n");
};

const messages: DisplayMessage[] = [
  { id: "banner", role: "banner", content: "" },
  ...Array.from({ length: 12 }, (_, i): DisplayMessage[] => [
    { id: `u${i}`, role: "user", content: `question number ${i}` },
    { id: `a${i}`, role: "assistant", content: `answer number ${i}` },
  ]).flat(),
];

/** app.tsx's shape: frame pinned to the terminal, chrome measured, real list. */
const AppShape = ({ onRootWheel }: { onRootWheel?: () => void }) => {
  const chromeRef = useRef<DOMElement | null>(null);
  const [chromeHeight, setChromeHeight] = useState(8);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const measured = measureElement(chromeRef.current).height;
    if (measured > 0 && measured !== chromeHeight) setChromeHeight(measured);
  });

  const viewport = Math.max(3, ROWS - chromeHeight);

  return h(
    Box,
    {
      flexDirection: "column",
      height: ROWS,
      onWheel(event: WheelEventData) {
        onRootWheel?.();
        setScrollOffset((prev) =>
          Math.max(0, event.direction === "up" ? prev + 3 : prev - 3),
        );
      },
    },
    h(MessageList, {
      messages,
      toolDetailKey: "ctrl+o",
      height: viewport,
      scrollOffset,
      onScrollChange: setScrollOffset,
    }),
    h(
      Box,
      { flexDirection: "column", flexShrink: 0, ref: chromeRef },
      h(Text, { key: "prompt" }, "> type a message"),
      h(Text, { key: "status" }, "model - 0 tokens"),
      h(Text, { key: "hint" }, "hint line"),
    ),
  );
};

const settle = async (instance: {
  waitUntilRenderFlush: () => Promise<void>;
}) => {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    // eslint-disable-next-line no-await-in-loop
    await instance.waitUntilRenderFlush();
  }
};

const mount = async (onRootWheel?: () => void) => {
  const stdout = makeStdout();
  const stdin = makeStdin();
  const instance = render(h(AppShape, { onRootWheel }), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle(instance);
  return { instance, stdout, stdin };
};

// SGR wheel-up: CSI < 64 ; col ; row M
const wheel = (direction: "up" | "down", row: number) =>
  Buffer.from(`\x1b[<${direction === "up" ? 64 : 65};10;${row}M`);

describe("MessageList inside the app frame", () => {
  it("never paints a frame taller than the terminal", async () => {
    const { instance, stdout } = await mount();
    // +1 because the frame is written with a trailing newline.
    expect(lastFrame(stdout.chunks).length).toBeLessThanOrEqual(ROWS + 1);
    instance.unmount();
  });

  it("keeps the chrome on screen instead of pushing it off the bottom", async () => {
    const { instance, stdout } = await mount();
    const frame = lastFrame(stdout.chunks).join("\n");
    expect(frame).toContain("type a message");
    expect(frame).toContain("hint line");
    instance.unmount();
  });

  it("starts pinned to the newest message", async () => {
    const { instance, stdout } = await mount();
    const frame = lastFrame(stdout.chunks).join("\n");
    expect(frame).toContain("answer number 11");
    expect(frame).not.toContain("answer number 0");
    instance.unmount();
  });

  it("scrolls the transcript on wheel-up and back down again", async () => {
    const { instance, stdout, stdin } = await mount();
    const atBottom = lastFrame(stdout.chunks).join("\n");

    for (let i = 0; i < 8; i++) {
      stdin.emit("data", wheel("up", 2));
    }

    await settle(instance);
    const scrolled = lastFrame(stdout.chunks).join("\n");

    // Real movement, not just a repaint of the same rows.
    expect(scrolled).not.toBe(atBottom);
    expect(scrolled).not.toContain("answer number 11");
    // ...and the frame is still the right size while scrolled.
    expect(lastFrame(stdout.chunks).length).toBeLessThanOrEqual(ROWS + 1);

    for (let i = 0; i < 20; i++) {
      stdin.emit("data", wheel("down", 2));
    }

    await settle(instance);
    expect(lastFrame(stdout.chunks).join("\n")).toContain("answer number 11");
    instance.unmount();
  });

  it("scrolls when the pointer is over the chrome, not just the transcript", async () => {
    const { instance, stdout, stdin } = await mount();
    const atBottom = lastFrame(stdout.chunks).join("\n");

    for (let i = 0; i < 8; i++) {
      stdin.emit("data", wheel("up", ROWS - 1));
    }

    await settle(instance);
    expect(lastFrame(stdout.chunks).join("\n")).not.toBe(atBottom);
    instance.unmount();
  });

  it("can reach the very top of the transcript", async () => {
    const { instance, stdout, stdin } = await mount();
    // The oldest message is far outside the viewport. Reaching it proves the
    // scroll range covers the real content height, rather than collapsing to
    // the child count as it did when every message measured a single row.
    for (let i = 0; i < 60; i++) {
      stdin.emit("data", wheel("up", 2));
    }

    await settle(instance);
    const frame = lastFrame(stdout.chunks);
    expect(frame.join("\n")).toContain("question number 0");
    expect(frame.length).toBeLessThanOrEqual(ROWS + 1);
    instance.unmount();
  });
});
