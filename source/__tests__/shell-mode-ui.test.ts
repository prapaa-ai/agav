import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import MessageList, { type DisplayMessage } from "../components/message-list.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

vi.mock("../config/prompt-history.js", () => ({ loadPromptHistory: async () => [], savePromptHistory: async () => {} }));

async function mount(element: ReturnType<typeof h>, columns = 100) {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns, rows: 100, write: (text: string) => { chunks.push(text); return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const instance = render(element, { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    await instance.waitUntilRenderFlush();
  };
  await settle();
  return { instance, stdin, settle, frame: () => chunks.map(text => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).filter(text => /[a-z]/i.test(text)).at(-1) ?? "" };
}

describe("shell mode UI", () => {
  it("indicates shell mode including leading whitespace and overrides agent routing", async () => {
    const props = { value: "  !printf hello", onChange: vi.fn(), onSubmit: vi.fn(), keybindings: DEFAULT_KEYBINDINGS, agentLock: "github" };
    const ui = await mount(h(InputPrompt, props));
    try {
      expect(ui.frame()).toContain("Shell ›");
      expect(ui.frame()).not.toContain("github ›");
      ui.instance.rerender(h(InputPrompt, { ...props, value: "hello" }));
      await ui.settle();
      expect(ui.frame()).toContain("github ›");
      expect(ui.frame()).not.toContain("Shell ›");
    } finally { ui.instance.unmount(); }
  });

  it("renders all shell output literally, separately from analysis, without tool preview truncation", async () => {
    const output = ["**literal**, not markdown", "", "  indented", "x".repeat(150), ...Array.from({ length: 35 }, (_, i) => `line-${i}`)].join("\n");
    const messages: DisplayMessage[] = [
      { id: "shell", role: "tool", toolName: "shell", toolDisplayName: "$ printf output", content: output },
      { id: "analysis", role: "assistant", content: "Model analysis is separate" },
    ];
    const ui = await mount(h(MessageList, { messages, columns: 200, toolDetailKey: "ctrl+o" }), 200);
    try {
      const frame = ui.frame();
      expect(frame).toContain("Shell output");
      expect(frame).toContain("$ printf output");
      expect(frame).toContain("**literal**, not markdown\n\n  indented");
      expect(frame).toContain("x".repeat(150));
      expect(frame).toContain("line-34");
      expect(frame).toContain("Model analysis is separate");
      expect(frame.indexOf("line-34")).toBeLessThan(frame.indexOf("Model analysis"));
    } finally { ui.instance.unmount(); }
  });

  it.each(["Ctrl+D", "ctrl+o"])("omits the %s expand-tools hint after fully expanded shell output", async toolDetailKey => {
    const messages: DisplayMessage[] = [
      { id: "shell", role: "tool", toolName: "shell", content: "first\nlast" },
      { id: "analysis", role: "assistant", content: "Model analysis" },
    ];
    const ui = await mount(h(MessageList, { messages, columns: 100, toolDetailKey }));
    try {
      expect(ui.frame()).toContain("first\nlast");
      expect(ui.frame()).toContain("Model analysis");
      expect(ui.frame()).not.toContain("to expand tools");
    } finally { ui.instance.unmount(); }
  });

  it.each(["run_command", "read_file", "image", undefined])("preserves the expand-tools hint after other tools (%s), including rerenders", async toolName => {
    const messages: DisplayMessage[] = [
      { id: "tool", role: "tool", toolName, content: "first\nsecond" },
      { id: "analysis", role: "assistant", content: "Model analysis" },
    ];
    const ui = await mount(h(MessageList, { messages, columns: 100, toolDetailKey: "Ctrl+D" }));
    try {
      expect(ui.frame()).toContain("(Ctrl+D to expand tools)");
      ui.instance.rerender(h(MessageList, { messages: [{ ...messages[0]!, toolName: "shell" }, messages[1]!], columns: 100, toolDetailKey: "Ctrl+D" }));
      await ui.settle();
      expect(ui.frame()).toContain("Shell output");
      expect(ui.frame()).toContain("Model analysis");
      expect(ui.frame()).not.toContain("to expand tools");
      ui.instance.rerender(h(MessageList, { messages, columns: 100, toolDetailKey: "Ctrl+D" }));
      await ui.settle();
      expect(ui.frame()).toContain("(Ctrl+D to expand tools)");
    } finally { ui.instance.unmount(); }
  });

  it.each([false, true])("shows empty shell output explicitly (error: %s)", async isError => {
    const ui = await mount(h(MessageList, { messages: [{ id: "shell", role: "tool", toolName: "shell", content: "", isError }], columns: 100, toolDetailKey: "ctrl+o" }));
    try {
      expect(ui.frame()).toContain("Shell output");
      expect(ui.frame()).toContain("(no output)");
      expect(ui.frame()).toContain(isError ? "✗" : "✓");
    } finally { ui.instance.unmount(); }
  });

  it("retains compact previews for ordinary agent tool calls", async () => {
    const ui = await mount(h(MessageList, { messages: [{ id: "tool", role: "tool", toolName: "run_command", content: "first\nsecond" }], columns: 100, toolDetailKey: "ctrl+o" }));
    try {
      expect(ui.frame()).toContain("first...");
      expect(ui.frame()).not.toContain("second");
      expect(ui.frame()).not.toContain("Shell output");
    } finally { ui.instance.unmount(); }
  });
});
