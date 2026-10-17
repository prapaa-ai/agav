import { EventEmitter } from "node:events";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import render from "../ink/render.js";
import StatusBar from "../components/status-bar.js";

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
  copyNotice: "Copied to clipboard" as const,
};

describe("status bar copy notice", () => {
  it("keeps /ps loading and response visible ahead of the copy notice", async () => {
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
    const instance = render(createElement(StatusBar, { ...baseProps, psLoading: true }), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    const frame = async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      await instance.waitUntilRenderFlush();
      return chunks.join("");
    };

    try {
      expect(await frame()).toContain("ps: thinking...");
      expect(chunks.join("")).not.toContain("Copied to clipboard");

      chunks.length = 0;
      instance.rerender(createElement(StatusBar, { ...baseProps, psResponse: "Side answer" }));
      expect(await frame()).toContain("ps: Side answer");
      expect(chunks.join("")).not.toContain("Copied to clipboard");

      chunks.length = 0;
      instance.rerender(createElement(StatusBar, baseProps));
      expect(await frame()).toContain("Copied to clipboard");
    } finally {
      instance.unmount();
    }
  });
});
