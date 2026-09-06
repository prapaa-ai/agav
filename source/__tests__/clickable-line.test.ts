import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import { Box } from "../ink/index.js";
import ClickableLine from "../components/clickable-line.js";

const ROWS = 10;
const COLS = 40;

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

// SGR mouse: `CSI < button ; col ; row` then `M` to press, `m` to release.
// Columns and rows are 1-based on the wire. A click is a press and a release
// on the same cell.
const clickAt = async (
  instance: { waitUntilRenderFlush: () => Promise<void> },
  stdin: NodeJS.ReadStream,
  column: number,
  row: number,
) => {
  const at = `0;${column + 1};${row + 1}`;
  stdin.emit("data", Buffer.from(`\x1b[<${at}M`));
  stdin.emit("data", Buffer.from(`\x1b[<${at}m`));
  await settle(instance);
};

// Strips SGR color/style codes as well as the terminal-mode escapes Ink's
// renderer emits around a frame (mouse tracking, cursor show/hide, etc.).
const stripAnsi = (s: string) => s.replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, "");

describe("ClickableLine", () => {
  it("renders plain runs with no extra characters beyond the text", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(ClickableLine, { runs: [{ text: "hello world" }] }), {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await settle(instance);

    const lastFrame = stripAnsi(stdout.chunks.join(""));
    expect(lastFrame).toContain("hello world");
    // The row line itself should be exactly the text, not padded/altered.
    const lines = lastFrame.split("\n").map((l) => l.replace(/\r$/, ""));
    const helloLine = lines.find((l) => l.includes("hello world"));
    expect(helloLine?.trimEnd()).toBe("hello world");

    instance.unmount();
  });

  it("invokes onOpen with the run's targetId when a clickable run is clicked", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const onOpen = vi.fn();
    const runs = [
      { text: "before " },
      { text: "TARGET", targetId: "t1", color: "cyan", underline: true },
      { text: " after" },
    ];
    const instance = render(h(ClickableLine, { runs, onOpen }), {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await settle(instance);

    // "before " is 7 chars (columns 0-6), "TARGET" spans columns 7-12.
    await clickAt(instance, stdin, 9, 0);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("t1");

    instance.unmount();
  });

  it("does not invoke onOpen when clicking a plain (non-target) run", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const onOpen = vi.fn();
    const runs = [
      { text: "before " },
      { text: "TARGET", targetId: "t1", color: "cyan", underline: true },
      { text: " after" },
    ];
    const instance = render(h(ClickableLine, { runs, onOpen }), {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await settle(instance);

    // Column 2 lands inside "before ".
    await clickAt(instance, stdin, 2, 0);

    expect(onOpen).not.toHaveBeenCalled();

    instance.unmount();
  });

  it("resolves clicks on both halves of a link wrapped across two rows to the same target", async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const onOpen = vi.fn();
    const tree = h(
      Box,
      { flexDirection: "column" },
      h(ClickableLine, { runs: [{ text: "TARGET", targetId: "t1" }], onOpen }),
      h(ClickableLine, { runs: [{ text: "MORE", targetId: "t1" }], onOpen }),
    );
    const instance = render(tree, {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await settle(instance);

    // Row 0: "TARGET" at columns 0-5.
    await clickAt(instance, stdin, 2, 0);
    // Row 1: "MORE" at columns 0-3.
    await clickAt(instance, stdin, 1, 1);

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenNthCalledWith(1, "t1");
    expect(onOpen).toHaveBeenNthCalledWith(2, "t1");

    instance.unmount();
  });
});
