import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import ContextWindowPrompt, { normalizePastedTokens } from "../components/context-window-prompt.js";
import render from "../ink/render.js";

describe("normalizePastedTokens", () => {
  it.each([
    ["32768", "32768"],
    ["32,768", "32768"],
    ["1,048,576", "1048576"],
    ["200,000", "200000"],
    ["0", "0"],
  ])("accepts %s as %s", (text, digits) => {
    expect(normalizePastedTokens(text)).toBe(digits);
  });

  it.each(["32,76", "3276,8", ",768", "32,768,", "32,,768", "1,0485,76", "32_768", "32 768", "32.768", "", "abc"])(
    "rejects %j",
    (text) => {
      expect(normalizePastedTokens(text)).toBeNull();
    },
  );
});

describe("context window prompt paste", () => {
  it.each([
    { name: "a comma-grouped paste", input: "\x1b[200~32,768\x1b[201~\r", expected: 32_768 },
    { name: "a malformed paste, leaving the typed value", input: "16\x1b[200~32,76\x1b[201~\r", expected: 16 },
  ])("submits $expected after $name", async ({ input, expected }) => {
    const chunks: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 100, rows: 40,
      write: (text: string) => { chunks.push(text); return true; },
    }) as unknown as NodeJS.WriteStream;
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true, setRawMode() { return this; }, resume() { return this; }, pause() { return this; }, read: () => null,
    }) as unknown as NodeJS.ReadStream;
    const onSubmit = vi.fn();
    const instance = render(h(ContextWindowPrompt, { model: "stealth/unknown", defaultValue: 16_384, onSubmit }), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    const flush = async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      await instance.waitUntilRenderFlush();
    };
    try {
      await flush();
      stdin.emit("data", Buffer.from(input));
      await flush();
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expected);
    } finally { instance.unmount(); }
  });
});
