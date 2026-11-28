import { EventEmitter } from "node:events";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import render from "../ink/render.js";
import StatusBar from "../components/status-bar.js";
import { defaultStatusBarLayout } from "../config/status-bar-layout.js";

const baseProps = {
  model: "mock", provider: "test", effort: "low", messageCount: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  hint: "A normal hint",
};
const notice = "Queued /job: Cannot open a new UI while working. Waiting for idle.";
type Props = Parameters<typeof StatusBar>[0];

function mount(props: Props, columns = 100) {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns, rows: 24, write: (text: string) => { chunks.push(text); return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const instance = render(createElement(StatusBar, props), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  return {
    instance,
    async frame(next?: Props) {
      if (next) { chunks.length = 0; instance.rerender(createElement(StatusBar, next)); }
      await new Promise(resolve => setTimeout(resolve, 60));
      await instance.waitUntilRenderFlush();
      return chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[=>]/g, "");
    },
  };
}

// Each captured update contains one dynamic frame and a trailing newline.
function height(frame: string) { return frame.replace(/\n$/, "").split("\n").length; }

describe("queued command footer notice", () => {
  it("replaces the hint, retains clipboard and /ps precedence, then restores the notice", async () => {
    const props = { ...baseProps, queuedCommandNotice: notice };
    const ui = mount(props);
    try {
      const initial = await ui.frame();
      expect(initial).toContain(notice);
      expect(initial).not.toContain("A normal hint");
      const copied = await ui.frame({ ...props, copyNotice: "Copied to clipboard" });
      expect(copied).toContain("Copied to clipboard");
      expect(copied).not.toContain(notice);
      const loading = await ui.frame({ ...props, copyNotice: "Copied to clipboard", psLoading: true });
      expect(loading).toContain("ps: thinking...");
      expect(loading).not.toContain(notice);
      expect(loading).not.toContain("Copied to clipboard");
      const answer = await ui.frame({ ...props, psResponse: "Side answer" });
      expect(answer).toContain("ps: Side answer");
      expect(answer).not.toContain(notice);
      expect(await ui.frame(props)).toContain(notice);
      const cleared = await ui.frame(baseProps);
      expect(cleared).not.toContain(notice);
      expect(cleared).toContain("A normal hint");
    } finally { ui.instance.unmount(); }
  });

  it.each([40, 100])("keeps the reserved footer height at %i columns with hints disabled", async columns => {
    const props = { ...baseProps, layout: defaultStatusBarLayout().map(item => item.id === "hint" ? { ...item, enabled: false } : item) };
    const ui = mount(props, columns);
    try {
      const without = await ui.frame();
      const shown = await ui.frame({ ...props, queuedCommandNotice: notice });
      expect(shown).toContain("Queued /job:");
      expect(height(shown)).toBe(height(without));
      if (columns === 40) {
        expect(shown).not.toContain(notice);
        const noticeLine = shown.split("\n").find(line => line.includes("Queued /job:"))!;
        expect(noticeLine.length).toBeLessThanOrEqual(columns);
        expect(shown).not.toContain("Waiting for idle.");
      } else expect(shown).toContain(notice);
      expect(height(await ui.frame(props))).toBe(height(without));
    } finally { ui.instance.unmount(); }
  });
});
