import { describe, it, expect } from "vitest";
import { normalizeKeyEvent } from "../config/keybindings.js";

const ESC = String.fromCharCode(27);

const blankKey = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false,
};

/**
 * Ink strips one leading ESC off a chunk `parseKeypress` could not resolve, so
 * the first report in a chunk reaches `normalizeKeyEvent` without it.
 */
const asInk = (raw: string) => (raw.startsWith(ESC) ? raw.slice(1) : raw);

describe("normalizeKeyEvent — mouse reports", () => {
  const wheelUp = `${ESC}[<64;10;5M`;
  const wheelDown = `${ESC}[<65;10;5M`;
  const press = `${ESC}[<0;10;5M`;
  const release = `${ESC}[<0;10;5m`;
  const legacy = `${ESC}[M !!`;

  it("swallows SGR reports after Ink has stripped the escape", () => {
    for (const raw of [wheelUp, wheelDown, press, release]) {
      expect(normalizeKeyEvent(asInk(raw), blankKey).input).toBe("");
    }
  });

  it("swallows legacy reports", () => {
    expect(normalizeKeyEvent(asInk(legacy), blankKey).input).toBe("");
  });

  it("swallows several reports batched into one chunk", () => {
    expect(normalizeKeyEvent(asInk(wheelUp + wheelUp + wheelDown), blankKey).input).toBe("");
  });

  it("keeps a real keystroke that trails a mouse report", () => {
    expect(normalizeKeyEvent(asInk(wheelUp) + "a", blankKey).input).toBe("a");
  });

  it("does not synthesise arrow keys from the wheel", () => {
    const { key } = normalizeKeyEvent(asInk(wheelUp), blankKey);
    expect(key.upArrow).toBe(false);
    expect(key.downArrow).toBe(false);
  });

  it("leaves ordinary input alone", () => {
    for (const input of ["a", "[", "O", "]", "1", "日", "🇺🇸", "hello world"]) {
      expect(normalizeKeyEvent(input, blankKey).input).toBe(input);
    }
  });

  it("still decodes xterm modifyOtherKeys sequences", () => {
    const { key } = normalizeKeyEvent(asInk(`${ESC}[27;5;13~`), blankKey);
    expect(key.return).toBe(true);
    expect(key.ctrl).toBe(true);
  });

  it("still folds linefeed into Ctrl+J", () => {
    const { input, key } = normalizeKeyEvent("\n", blankKey);
    expect(input).toBe("j");
    expect(key.ctrl).toBe(true);
  });
});
