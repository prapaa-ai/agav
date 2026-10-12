import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { DisplayMessage } from "../components/message-list.js";
import type { AgavConfig } from "../config/config.js";

const boundary = vi.hoisted(() => ({ submit: vi.fn(), intervene: vi.fn(), cancel: vi.fn(), promptProps: undefined as any, handleSubmit: undefined as undefined | ((value: string) => Promise<void>), busy: false, paused: false }));
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../components/input-prompt.js", () => ({ default: (props: any) => { boundary.promptProps = props; boundary.handleSubmit = props.onSubmit; return null; } }));
vi.mock("../hooks/use-agent.js", () => ({ useAgent: () => {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  return {
    messages, isLoading: boundary.busy, isGenerationPaused: boundary.paused, toolCalls: [], subagentStates: [], loadedPlugins: [], mcpServers: [],
    mcpPromptCommands: [], skillCommands: [], agentCommands: [], tokenUsage: { inputTokens: 0, outputTokens: 0 },
    conversation: { getMessages: () => [] }, submit: boundary.submit,
    addDisplayMessage: (message: DisplayMessage) => setMessages(prev => [...prev, message]),
    cancel: boundary.cancel, interveneWhilePaused: boundary.intervene,
  };
} }));

async function mount() {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 24, write: (text: string) => { chunks.push(text); return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 1, permissionMode: "ask" };
  const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  await instance.waitUntilRenderFlush();
  return {
    instance, stdin,
    rerender: () => instance.rerender(h(App, { config, keybindings: DEFAULT_KEYBINDINGS })),
    output: () => chunks.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""),
    frame: () => chunks.map(text => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).filter(text => /[a-z]/i.test(text)).at(-1) ?? "",
  };
}

describe("request queuing", () => {
  it("retains a rejected paused intervention and serializes later prompts", async () => {
    boundary.busy = true; boundary.paused = true;
    let resolve!: (accepted: boolean) => void;
    boundary.intervene.mockReset().mockReturnValue(new Promise<boolean>(r => { resolve = r; }));
    boundary.submit.mockReset();
    const ui = await mount();
    try {
      boundary.promptProps.onChange("intervention");
      await vi.waitFor(() => expect(boundary.promptProps.value).toBe("intervention"));
      const pending = boundary.handleSubmit!("intervention");
      expect(boundary.intervene).toHaveBeenCalledTimes(1);
      await boundary.handleSubmit!("later");
      expect(boundary.intervene).toHaveBeenCalledTimes(1);
      boundary.busy = false; boundary.paused = false; ui.rerender();
      await new Promise(r => setTimeout(r, 60));
      expect(boundary.submit).not.toHaveBeenCalled();
      boundary.busy = true; resolve(false); await pending;
      // Rejection must not erase a newer draft either.
      boundary.promptProps.onChange("retry intervention");
      await vi.waitFor(() => expect(boundary.promptProps.value).toBe("retry intervention"));
    } finally { resolve(false); boundary.busy = false; boundary.paused = false; ui.instance.unmount(); }
  });

  it("does not clear a rejected intervention's text or attachments", async () => {
    boundary.busy = true; boundary.paused = true;
    boundary.intervene.mockReset().mockResolvedValue(false);
    const ui = await mount();
    try {
      boundary.promptProps.onPaste("retained attachment".repeat(8), (label: string) => boundary.promptProps.onChange(label));
      await vi.waitFor(() => expect(boundary.promptProps.value).toContain("Pasted"));
      const draft = boundary.promptProps.value;
      await boundary.handleSubmit!(draft);
      expect(boundary.promptProps.value).toBe(draft);
      await boundary.handleSubmit!(draft);
      expect(boundary.intervene.mock.calls[1]![1]).toEqual([expect.objectContaining({ text: "retained attachment".repeat(8) })]);
    } finally { boundary.busy = false; boundary.paused = false; ui.instance.unmount(); }
  });

  it("Escape in queue management closes the queue without cancelling preparation", async () => {
    boundary.busy = false; boundary.cancel.mockReset();
    let resolve!: (accepted: boolean) => void;
    boundary.submit.mockReset().mockReturnValue(new Promise<boolean>(r => { resolve = r; }));
    const ui = await mount();
    try {
      const pending = boundary.handleSubmit!("preparing");
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      await boundary.handleSubmit!("later");
      ui.stdin.emit("data", Buffer.from("\x11"));
      await new Promise(r => setTimeout(r, 60));
      ui.stdin.emit("data", Buffer.from("\x1b"));
      await new Promise(r => setTimeout(r, 60));
      expect(boundary.cancel).not.toHaveBeenCalled();
      boundary.busy = true; resolve(false); await pending;
    } finally { resolve(false); boundary.busy = false; ui.instance.unmount(); }
  });

  it("preserves synchronous text edits and removes only submitted attachments after acceptance", async () => {
    boundary.busy = false;
    let resolve!: (accepted: boolean) => void;
    boundary.submit.mockReset().mockReturnValue(new Promise<boolean>(r => { resolve = r; }));
    const ui = await mount();
    try {
      boundary.promptProps.onPaste("submitted attachment".repeat(8), (label: string) => boundary.promptProps.onChange(label));
      await vi.waitFor(() => expect(boundary.promptProps.value).toContain("Pasted"));
      const pending = boundary.handleSubmit!(boundary.promptProps.value);
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      boundary.promptProps.onPaste("new attachment".repeat(8), () => {});
      boundary.promptProps.onChange("new draft");
      resolve(true); await pending;
      await vi.waitFor(() => expect(boundary.promptProps.value).toBe("new draft"));
      boundary.submit.mockResolvedValue(false);
      await boundary.handleSubmit!("new draft");
      expect(boundary.submit.mock.calls[1]![1]).toEqual([expect.objectContaining({ text: "new attachment".repeat(8) })]);
    } finally { resolve(true); ui.instance.unmount(); }
  });

  it.each(["\u001b", "\u0003"])("cancels preparation before isLoading via %j", async key => {
    boundary.busy = false; boundary.cancel.mockReset();
    let resolve!: (accepted: boolean) => void;
    boundary.submit.mockReset().mockReturnValue(new Promise<boolean>(r => { resolve = r; }));
    const ui = await mount();
    try {
      const pending = boundary.handleSubmit!("preparing");
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      ui.stdin.emit("data", Buffer.from(key));
      await vi.waitFor(() => expect(boundary.cancel).toHaveBeenCalledTimes(1));
      resolve(false); await pending;
    } finally { resolve(false); ui.instance.unmount(); }
  });
  it("queues FIFO, cancels a middle item, and drains only when idle", async () => {
    boundary.busy = true;
    boundary.submit.mockReset().mockImplementation(async () => { boundary.busy = true; return true; });
    const ui = await mount();
    try {
      await boundary.handleSubmit!("first queued");
      await boundary.handleSubmit!("middle queued");
      await boundary.handleSubmit!("last queued");
      await vi.waitFor(() => expect(ui.output()).toContain("Queued 3"));
      expect(boundary.submit).not.toHaveBeenCalled();
      ui.stdin.emit("data", Buffer.from("\x11"));
      await new Promise(resolve => setTimeout(resolve, 60));
      ui.stdin.emit("data", Buffer.from("\x1b[B"));
      await new Promise(resolve => setTimeout(resolve, 60));
      ui.stdin.emit("data", Buffer.from("\x7f"));
      await vi.waitFor(() => expect(ui.output()).toContain("Queued 2"));
      ui.stdin.emit("data", Buffer.from("\x1b"));
      await new Promise(resolve => setTimeout(resolve, 60));
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      expect(boundary.submit.mock.calls[0]![0]).toBe("first queued");
      ui.rerender();
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(boundary.submit).toHaveBeenCalledTimes(1);
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(2));
      expect(boundary.submit.mock.calls[1]![0]).toBe("last queued");
    } finally { boundary.busy = false; ui.instance.unmount(); }
  });

  it("retains rejected queued input without spinning and retries explicitly", async () => {
    boundary.busy = true;
    boundary.submit.mockReset().mockResolvedValue(false);
    const ui = await mount();
    try {
      await boundary.handleSubmit!("retry me");
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(ui.output()).toContain("Queue paused"));
      expect(boundary.submit).toHaveBeenCalledTimes(1);
      ui.rerender();
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(boundary.submit).toHaveBeenCalledTimes(1);
      boundary.submit.mockResolvedValue(true);
      await boundary.handleSubmit!("/queue retry");
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(2));
    } finally { ui.instance.unmount(); }
  });

  it("does not queue /ps or safe mid-turn commands", async () => {
    boundary.busy = true;
    boundary.submit.mockReset();
    const ui = await mount();
    try {
      await boundary.handleSubmit!("/ps what is happening?");
      await boundary.handleSubmit!("/steer check edge cases");
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(ui.output()).not.toContain("Queued 1");
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { boundary.busy = false; ui.instance.unmount(); }
  });

  it("queues rapid submissions while the first prompt is still preparing", async () => {
    boundary.busy = false;
    let resolve!: (accepted: boolean) => void;
    boundary.submit.mockReset().mockReturnValueOnce(new Promise<boolean>(r => { resolve = r; })).mockImplementation(async () => { boundary.busy = true; return true; });
    const ui = await mount();
    try {
      const pending = boundary.handleSubmit!("preparing");
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      await boundary.handleSubmit!("second");
      await boundary.handleSubmit!("third");
      await vi.waitFor(() => expect(ui.output()).toContain("Queued 2"));
      boundary.busy = true;
      resolve(true); await pending; ui.rerender();
      expect(boundary.submit).toHaveBeenCalledTimes(1);
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(2));
      expect(boundary.submit.mock.calls[1]![0]).toBe("second");
    } finally { resolve(true); boundary.busy = false; ui.instance.unmount(); }
  });
  it("snapshots queued paste attachments and does not erase a new draft on dispatch", async () => {
    boundary.busy = true;
    boundary.submit.mockReset().mockImplementation(async () => { boundary.busy = true; return true; });
    const ui = await mount();
    try {
      boundary.promptProps.onPaste("a sufficiently large pasted attachment with useful content".repeat(4), (label: string) => boundary.promptProps.onChange(label));
      await vi.waitFor(() => expect(boundary.promptProps.value).toContain("Pasted"));
      const value = boundary.promptProps.value;
      await boundary.handleSubmit!(value);
      await vi.waitFor(() => expect(boundary.promptProps.value).toBe(""));
      boundary.promptProps.onChange("draft for later");
      await vi.waitFor(() => expect(boundary.promptProps.value).toBe("draft for later"));
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      expect(boundary.submit.mock.calls[0]![1]).toEqual([expect.objectContaining({ type: "text" })]);
      expect(boundary.promptProps.value).toBe("draft for later");
    } finally { boundary.busy = false; ui.instance.unmount(); }
  });

  it("drains multiple non-turn commands without stalling", async () => {
    boundary.busy = true;
    boundary.submit.mockReset();
    const ui = await mount();
    try {
      await boundary.handleSubmit!("/unknown-one");
      await boundary.handleSubmit!("/unknown-two");
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(ui.output()).toContain("Unknown command: /unknown-two"));
      expect(boundary.submit).not.toHaveBeenCalled();
    } finally { boundary.busy = false; ui.instance.unmount(); }
  });

  it("interrupts only the active turn and runs the remaining queued prompt afterwards", async () => {
    boundary.busy = true;
    boundary.cancel.mockReset();
    boundary.submit.mockReset().mockImplementation(async () => { boundary.busy = true; return true; });
    const ui = await mount();
    try {
      await boundary.handleSubmit!("after cancellation");
      await vi.waitFor(() => expect(ui.output()).toContain("Queued 1"));
      ui.stdin.emit("data", Buffer.from("\x1b"));
      await vi.waitFor(() => expect(boundary.cancel).toHaveBeenCalledTimes(1));
      expect(boundary.submit).not.toHaveBeenCalled();
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      expect(boundary.submit.mock.calls[0]![0]).toBe("after cancellation");
    } finally { boundary.busy = false; ui.instance.unmount(); }
  });

  it.skipIf(process.platform === "win32")("defers direct shell execution until the active turn ends", async () => {
    boundary.busy = true;
    boundary.submit.mockReset().mockImplementation(async () => { boundary.busy = true; return true; });
    const ui = await mount();
    try {
      await boundary.handleSubmit!("!printf deferred-shell-output");
      await vi.waitFor(() => expect(ui.output()).toContain("Queued 1"));
      expect(boundary.submit).not.toHaveBeenCalled();
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      expect(boundary.submit.mock.calls[0]![3]).toEqual([expect.objectContaining({ content: "deferred-shell-output", toolName: "shell" })]);
    } finally { boundary.busy = false; ui.instance.unmount(); }
  });

});
