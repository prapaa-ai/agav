import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import render from "../ink/render.js";
import MessageList from "../components/message-list.js";
import type { DisplayMessage } from "../components/message-list.js";
import type { OpenRef } from "../utils/open-ref.js";
import { clearDetectionCache } from "../utils/detect-targets.js";

// Regression coverage for: ctrl+click did not work on a file path the *user*
// typed into a message, only on paths the agent mentioned — because the user
// bubble was painted as a single opaque `<Text>` band with no per-run click
// targets at all, unlike the assistant bubble which already went through
// `ClickableMarkdown`.

const ROWS = 20;
const COLS = 60;

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
    await new Promise((resolve) => setTimeout(resolve, 20));
    // eslint-disable-next-line no-await-in-loop
    await instance.waitUntilRenderFlush();
  }
};

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

describe("clicking a file path inside a user-typed message", () => {
  let root: string;

  afterEach(async () => {
    clearDetectionCache();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("resolves to the same path the user typed, opened via onOpenRef", async () => {
    root = await mkdtemp(join(tmpdir(), "agav-user-click-"));
    const origCwd = process.cwd();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export {}\n");
    process.chdir(root);

    try {
      const stdout = makeStdout();
      const stdin = makeStdin();
      let opened: OpenRef | null = null;

      const messages: DisplayMessage[] = [
        { id: "u1", role: "user", content: "please open src/app.ts for me" },
      ];

      const instance = render(
        h(MessageList, {
          messages,
          toolDetailKey: "ctrl+o",
          columns: COLS,
          onOpenRef: (ref: OpenRef) => { opened = ref; },
        }),
        { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
      );
      await settle(instance);
      // Detection is async (it stats the filesystem); give it one more
      // render cycle to land before scanning for the clickable run.
      await settle(instance);

      // "❯ please open " is 14 visible columns before "src/app.ts" begins,
      // on the row the message text prints to (row 0 is the band's top
      // padding line).
      const prefixLen = "❯ please open ".length;
      let found = false;
      for (let row = 0; row < 4 && !found; row++) {
        // eslint-disable-next-line no-await-in-loop
        await clickAt(instance, stdin, prefixLen + 2, row);
        if (opened) found = true;
      }

      expect(opened).not.toBeNull();
      expect((opened as unknown as OpenRef)?.kind).toBe("path");
      if (opened && (opened as OpenRef).kind === "path") {
        expect((opened as Extract<OpenRef, { kind: "path" }>).absPath).toBe(join(root, "src", "app.ts"));
      }

      instance.unmount();
    } finally {
      process.chdir(origCwd);
    }
  }, 15000);

  it("renders no clickable run (falls back to plain text) when no onOpenRef handler is provided", async () => {
    root = await mkdtemp(join(tmpdir(), "agav-user-click-noop-"));
    const origCwd = process.cwd();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export {}\n");
    process.chdir(root);

    try {
      const stdout = makeStdout();
      const stdin = makeStdin();

      const messages: DisplayMessage[] = [
        { id: "u1", role: "user", content: "please open src/app.ts for me" },
      ];

      const instance = render(
        h(MessageList, { messages, toolDetailKey: "ctrl+o", columns: COLS }),
        { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
      );
      await settle(instance);

      // Nothing to assert on click resolution since there's no handler; the
      // real assertion is that mounting/rendering without a handler does not
      // throw and still paints the message text.
      const painted = stdout.chunks.some((chunk) => chunk.includes("please open"));
      expect(painted).toBe(true);

      instance.unmount();
    } finally {
      process.chdir(origCwd);
    }
  });
});
