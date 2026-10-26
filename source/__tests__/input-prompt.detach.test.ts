import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { expect, it, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
vi.mock("../config/prompt-history.js", () => ({ loadPromptHistory: async () => [], savePromptHistory: async () => {} }));
it("consumes detach prefixes before editing and completed chords before custom submit", async () => {
  let text = "";
  const submit = vi.fn();
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null }) as unknown as NodeJS.ReadStream;
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true }) as unknown as NodeJS.WriteStream;
  const Host = () => {
    const [value, setValue] = useState("keep draft"); text = value;
    return h(InputPrompt, { value, onChange: setValue, onSubmit: submit,
      keybindings: { ...DEFAULT_KEYBINDINGS, detachSession: ["ctrl+u enter"], submit: ["enter"] } });
  };
  const instance = render(h(Host), { stdin, stdout, patchConsole: false, exitOnCtrlC: false });
  const send = async (key: string) => { stdin.emit("data", key); await new Promise(r => setTimeout(r, 40)); };
  try {
    await new Promise(r => setTimeout(r, 60));
    await send("\x15"); expect(text).toBe("keep draft");
    await send("\r"); expect(text).toBe("keep draft"); expect(submit).not.toHaveBeenCalled();
    await send("\r"); expect(submit).toHaveBeenCalledWith("keep draft");
  } finally { instance.unmount(); }
});
