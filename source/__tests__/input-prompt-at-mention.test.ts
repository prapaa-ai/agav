import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt, { getActiveFileToken } from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: async () => {},
}));

describe("input-prompt getActiveFileToken", () => {
  it("uses text up to caret as query while spanning the full unquoted mention", () => {
    const value = "review @READjunk please";
    const cursor = "review @READ".length;

    const token = getActiveFileToken(value, cursor);
    expect(token).not.toBeNull();
    expect(token!.query).toBe("READ");
    expect(value.slice(token!.start, token!.end)).toBe("@READjunk");
    expect(value.slice(token!.end)).toBe(" please");
  });

  it("spans the full quoted mention containing spaces on mid-token completion", () => {
    const value = 'review @"my docs/READjunk" please';
    const cursor = 'review @"my docs/READ'.length;

    const token = getActiveFileToken(value, cursor);
    expect(token).not.toBeNull();
    expect(token!.quoted).toBe(true);
    expect(token!.query).toBe("my docs/READ");
    expect(value.slice(token!.start, token!.end)).toBe('@"my docs/READjunk"');
    expect(value.slice(token!.end)).toBe(" please");
  });

  it("preserves end-of-token behavior", () => {
    const value = "review @READ";
    const token = getActiveFileToken(value, value.length);

    expect(token).toEqual({
      start: 7,
      end: value.length,
      query: "READ",
      quoted: false,
    });
  });

  it("does not swallow following prose when a quoted mention has no closing quote", () => {
    const value = 'review @"my_docs/READjunk please';
    const cursor = 'review @"my_docs/READ'.length;

    const token = getActiveFileToken(value, cursor);
    expect(token).not.toBeNull();
    expect(token!.query).toBe("my_docs/READ");
    expect(value.slice(token!.start, token!.end)).toBe('@"my_docs/READjunk');
    expect(value.slice(token!.end)).toBe(" please");
  });
});

describe("input-prompt quoted directory completion", () => {
  it("keeps the closing quote and places the caret before it when completing a quoted directory", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = mkdtempSync(join(tmpdir(), "agav-mention-"));
    mkdirSync(join(tmpRoot, "my docs", "Reports"), { recursive: true });
    process.chdir(tmpRoot);

    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 80,
      rows: 20,
      write: () => true,
    }) as unknown as NodeJS.WriteStream;
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode() { return this; },
      resume() { return this; },
      pause() { return this; },
      read: () => null,
    }) as unknown as NodeJS.ReadStream;

    let currentValue = "";
    const Host = () => {
      const [value, setValue] = useState(currentValue);
      currentValue = value;
      return h(InputPrompt, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        keybindings: DEFAULT_KEYBINDINGS,
      });
    };

    const instance = render(h(Host), {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    const settle = async (n = 5) => {
      for (let i = 0; i < n; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 25));
        // eslint-disable-next-line no-await-in-loop
        await instance.waitUntilRenderFlush();
      }
    };

    try {
      await settle();
      for (const ch of 'review @"my docs/Re" please') {
        stdin.emit("data", Buffer.from(ch));
        // eslint-disable-next-line no-await-in-loop
        await instance.waitUntilRenderFlush();
      }
      await settle();
      // Move left 8 chars ('" please') to right after 'Re'
      for (let i = 0; i < '" please'.length; i++) {
        stdin.emit("data", Buffer.from("\x1b[D"));
        // eslint-disable-next-line no-await-in-loop
        await instance.waitUntilRenderFlush();
      }
      await settle(8);

      // Complete 'Reports/' via Tab
      stdin.emit("data", Buffer.from("\t"));
      await settle();
      expect(currentValue).toBe('review @"my docs/Reports/" please');

      // Verify caret is just before the closing quote by typing a character
      stdin.emit("data", Buffer.from("X"));
      await settle();
      expect(currentValue).toBe('review @"my docs/Reports/X" please');
    } finally {
      instance.unmount();
      process.chdir(prevCwd);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
