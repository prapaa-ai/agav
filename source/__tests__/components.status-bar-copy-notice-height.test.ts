import { EventEmitter } from "node:events";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import render from "../ink/render.js";
import StatusBar from "../components/status-bar.js";
import { defaultStatusBarLayout, type StatusBarLayout } from "../config/status-bar-layout.js";

// Layout with the rotating hint line disabled. This is the configuration that
// exposed the bug: with no hint occupying the status bar's final slot, a copy
// notice would otherwise add a brand-new row, growing the dynamic frame by one
// line. The global selection highlight is keyed by absolute frame-row index, so
// that one-row shift left the top selected line rendered unhighlighted until the
// notice cleared and the frame height returned to normal.
const hintDisabledLayout: StatusBarLayout = defaultStatusBarLayout().map((item) =>
  item.id === "hint" ? { id: "hint", enabled: false } : item,
);

const baseProps = {
  model: "mock",
  provider: "test",
  effort: "low",
  messageCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  hint: "A normal hint",
  layout: hintDisabledLayout,
};

/**
 * Count the rendered rows in the latest frame.
 *
 * Intentionally does NOT strip trailing blank rows: the reserved empty status
 * bar slot is exactly such a row, and the whole point of the fix is that it
 * keeps occupying space whether or not the copy notice fills it. Trimming it
 * would hide the regression this test guards against.
 *
 * Ink writes each dynamic frame as a block ending in a single trailing newline.
 * We isolate the last frame (text after the final screen-clear escape) so prior
 * rerenders in the accumulated fake-stdout buffer do not inflate the count,
 * strip ANSI control sequences, then count the content rows.
 */
function frameHeight(frame: string): number {
  // Keep only the output after the last erase/clear so we measure one frame.
  const clearIdx = frame.lastIndexOf("\x1b[2K");
  const tail = clearIdx >= 0 ? frame.slice(frame.lastIndexOf("\n", clearIdx) + 1) : frame;
  const plain = tail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[=>]/g, "");
  const lines = plain.split("\n");
  // Drop only the single empty element produced by the frame's trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

describe("status bar copy notice frame height", () => {
  it("does not change the frame height when the copy notice appears (hint disabled)", async () => {
    const chunks: string[] = [];
    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, {
      isTTY: true, columns: 100, rows: 24,
      write: (chunk: string) => { chunks.push(chunk); return true; },
    });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, {
      isTTY: true,
      setRawMode: () => stdin,
      resume: () => stdin,
      pause: () => stdin,
      read: () => null,
    });

    const instance = render(createElement(StatusBar, { ...baseProps, copyNotice: null }), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    const frame = async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      await instance.waitUntilRenderFlush();
      return chunks.join("");
    };

    try {
      // Frame height with no copy notice and the hint disabled.
      const withoutNotice = frameHeight(await frame());

      // Show the copy notice; the frame must keep the same number of rows.
      chunks.length = 0;
      instance.rerender(createElement(StatusBar, { ...baseProps, copyNotice: "Copied to clipboard" }));
      const shown = await frame();
      expect(shown).toContain("Copied to clipboard");
      const withNotice = frameHeight(shown);

      expect(withNotice).toBe(withoutNotice);

      // And when the notice clears again, the height is still stable.
      chunks.length = 0;
      instance.rerender(createElement(StatusBar, { ...baseProps, copyNotice: null }));
      const afterClear = frameHeight(await frame());
      expect(afterClear).toBe(withoutNotice);
    } finally {
      instance.unmount();
    }
  });
});
