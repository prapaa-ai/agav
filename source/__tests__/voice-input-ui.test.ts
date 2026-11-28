import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import render from "../ink/render.js";
import VoiceInputPanel from "../components/voice-input.js";
import type { VoiceUIPhase } from "../hooks/use-voice-input.js";

async function mount(phase: Exclude<VoiceUIPhase, "model-consent" | "downloading">, columns: number, level = 0.5) {
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns, rows: 24, write: (text: string) => { chunks.push(text); return true; } }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null }) as unknown as NodeJS.ReadStream;
  const onStop = vi.fn(); const onCancel = vi.fn();
  const instance = render(h(VoiceInputPanel, { phase, columns, level, elapsedSeconds: 65, onStop, onCancel }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 30)); await instance.waitUntilRenderFlush();
  const frame = chunks.map(chunk => chunk.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).filter(chunk => chunk.includes("Voice")).at(-1) || "";
  return { instance, frame, stdin, onStop, onCancel };
}
const phases: Exclude<VoiceUIPhase, "model-consent" | "downloading">[] = ["preparing", "recording", "stopping", "transcribing", "cancelling"];
describe("compact voice controls", () => {
  for (const columns of [20, 28, 40, 48, 80]) {
    it.each(phases)(`renders %s with readable bounded controls at ${columns} columns`, async phase => {
      const ui = await mount(phase, columns);
      try {
        expect(ui.frame).toContain("Voice");
        expect(ui.frame.split("\n").every(line => stringWidth(line) <= columns)).toBe(true);
        expect(ui.frame.split("\n").filter(line => line.trim()).length).toBeLessThanOrEqual(5);
        if (phase === "recording") {
          expect(ui.frame).toContain("1:05");
          expect(ui.frame).toContain("Stop");
          const expectedShortcut = columns < 28
            ? (process.platform === "darwin" ? "⌥S Stop" : "Alt+S Stop")
            : columns < 48
              ? (process.platform === "darwin" ? "Option+S Stop" : "Alt+S Stop")
              : (process.platform === "darwin" ? "Option+S Stop to edit" : "Alt+S Stop to edit");
          expect(ui.frame).toContain(expectedShortcut);
          if (columns === 20) {
            const controlRow = ui.frame.split("\n").find((line) => line.includes("Stop"));
            expect(controlRow).toContain("Esc back");
            expect(stringWidth(controlRow!)).toBeLessThanOrEqual(columns);
          }
        }
        if (phase !== "cancelling") expect(ui.frame).toContain("Esc");
        else expect(ui.frame).toContain("Releasing");
      } finally { ui.instance.unmount(); }
    });
  }
  it("shows platform-appropriate Stop shortcuts at compact and full widths", async () => {
    const originalPlatform = process.platform;
    try {
      for (const [platform, tinyLabel, fullLabel] of [
        ["darwin", "⌥S Stop", "Option+S Stop to edit"],
        ["linux", "Alt+S Stop", "Alt+S Stop to edit"],
      ] as const) {
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        const tinyUi = await mount("recording", 20);
        try {
          const row = tinyUi.frame.split("\n").find((line) => line.includes("Stop"));
          expect(row).toContain(tinyLabel);
          expect(row).toContain("Esc back");
          expect(stringWidth(row!)).toBeLessThanOrEqual(20);
        } finally {
          tinyUi.instance.unmount();
        }
        const wideUi = await mount("recording", 80);
        try {
          expect(wideUi.frame).toContain(fullLabel);
        } finally {
          wideUi.instance.unmount();
        }
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
  it.each([0, 1, NaN])("uses a bounded real audio level of %s without animation", async level => {
    const ui = await mount("recording", 80, level);
    try { expect(ui.frame).toContain(level === 1 ? "[||||||||||||]" : "[............]"); }
    finally { ui.instance.unmount(); }
  });
  it("supports mouse stop and cancel without relying on color or keyboard handlers", async () => {
    const ui = await mount("recording", 80);
    try {
      // Margin row, title, meter, then controls: 1-based row 4.
      ui.stdin.emit("data", Buffer.from("\x1b[<0;3;4M\x1b[<0;3;4m"));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(ui.onStop).toHaveBeenCalledTimes(1);
      ui.stdin.emit("data", Buffer.from("\x1b[<0;25;4M\x1b[<0;25;4m"));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(ui.onCancel).toHaveBeenCalledTimes(1);
    } finally { ui.instance.unmount(); }
  });
});
