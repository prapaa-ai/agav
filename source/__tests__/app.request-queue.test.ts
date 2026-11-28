import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { CommandRegistry } from "../commands/registry.js";
import * as sandbox from "../utils/sandbox.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { DisplayMessage } from "../components/message-list.js";
import type { AgavConfig } from "../config/config.js";

const boundary = vi.hoisted(() => ({ submit: vi.fn(), intervene: vi.fn(), cancel: vi.fn(), promptProps: undefined as any, handleSubmit: undefined as undefined | ((value: string) => Promise<void>), busy: false, paused: false, workerAttached: false, detach: vi.fn(), canDetach: false, confirmation: undefined as any }));
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../components/input-prompt.js", () => ({ default: (props: any) => { boundary.promptProps = props; boundary.handleSubmit = props.onSubmit; return null; } }));
vi.mock("../hooks/use-agent.js", () => ({ useAgent: () => {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  return {
    messages, isLoading: boundary.busy, isWorkerAttached: boundary.workerAttached, isGenerationPaused: boundary.paused, toolCalls: [], subagentStates: [], loadedPlugins: [], mcpServers: [],
    mcpPromptCommands: [], skillCommands: [], agentCommands: [], tokenUsage: { inputTokens: 0, outputTokens: 0 },
    conversation: { getMessages: () => [] }, submit: boundary.submit,
    addDisplayMessage: (message: DisplayMessage) => setMessages(prev => [...prev, message]),
    detachSession: boundary.detach, canDetach: boundary.canDetach, pendingConfirmation: boundary.confirmation,
    cancel: boundary.cancel, interveneWhilePaused: boundary.intervene,
  };
} }));

async function mount(keybindings = DEFAULT_KEYBINDINGS) {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 24, write: (text: string) => { chunks.push(text); return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 1, permissionMode: "ask" };
  const instance = render(h(App, { config, keybindings }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  await instance.waitUntilRenderFlush();
  return {
    instance, stdin,
    rerender: () => instance.rerender(h(App, { config, keybindings })),
    output: () => chunks.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""),
    frame: () => chunks.map(text => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).filter(text => /[a-z]/i.test(text)).at(-1) ?? "",
  };
}

describe("request queuing", () => {

  it("dispatches /job list, /job stop and bare /branch mid-turn but queues disruptive variants", async () => {
    boundary.busy = true;
    const execute = vi.spyOn(CommandRegistry.prototype, "execute").mockImplementation(async input => ({ type: "message", text: `Executed ${input}` }));
    const ui = await mount();
    try {
      for (const input of ["/job list", "/job stop abc", "/branch"]) {
        await boundary.handleSubmit!(input);
        await vi.waitFor(() => expect(ui.output()).toContain(`Executed ${input}`));
      }
      expect(ui.output()).not.toContain("Queued 1");
      for (const input of ["/model", "/effort", "/permission", "/job", "/branch experiment"]) {
        await boundary.handleSubmit!(input);
        expect(execute).not.toHaveBeenCalledWith(input, expect.anything());
      }
      await vi.waitFor(() => expect(ui.output()).toContain("Queued 5"));
      expect(execute).toHaveBeenCalledTimes(3);
    } finally { ui.instance.unmount(); boundary.busy = false; execute.mockRestore(); }
  });

  it.each([
    ["/job", "Cannot open a new UI while working."],
    ["/model", "Cannot open a new UI while working."],
    ["/effort high", "Cannot modify execution or session state while working."],
    ["/permission ask", "Cannot modify execution or session state while working."],
    ["/unknown", "Cannot run this command in the current state."],
  ])("notifies immediately when %s is queued with its reason", async (input, reason) => {
    boundary.busy = true;
    const ui = await mount();
    try {
      await boundary.handleSubmit!(input);
      const name = input.split(" ")[0];
      await vi.waitFor(() => expect(ui.output()).toContain(`Queued ${name}: ${reason} Waiting for idle.`));
      expect(ui.output()).toContain("Queued 1");
    } finally { ui.instance.unmount(); boundary.busy = false; }
  });

  it("expires notices after 18 seconds, resets the timer on another enqueue, and does not restart on drain", async () => {
    boundary.busy = true;
    const execute = vi.spyOn(CommandRegistry.prototype, "execute").mockResolvedValue({ type: "message", text: "Queued command executed" });
    const ui = await mount();
    // Keep Ink's rendering timers real; capture only the notification timeout.
    const originalSetTimeout = globalThis.setTimeout;
    const notices: { callback: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
    const schedule = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      if (delay === 18_000) notices.push({ callback: () => callback(...args), timer });
      return timer;
    }) as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      await boundary.handleSubmit!("/effort high");
      await vi.waitFor(() => expect(ui.frame()).toContain("Queued /effort:"));
      expect(notices).toHaveLength(1);
      await boundary.handleSubmit!("/permission ask");
      await vi.waitFor(() => expect(ui.frame()).toContain("Queued /permission:"));
      expect(notices).toHaveLength(2);
      expect(clear).toHaveBeenCalledWith(notices[0]!.timer);
      // The captured callback represents the exact 18,000ms deadline, without
      // waiting 18 real seconds or advancing unrelated Ink timers.
      notices[1]!.callback();
      await vi.waitFor(() => expect(ui.frame()).not.toContain("Queued /permission:"));
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      expect(notices).toHaveLength(2);
      expect(ui.frame()).not.toContain("Queued /permission:");
      await boundary.handleSubmit!("/help");
      expect(notices).toHaveLength(2);
    } finally {
      ui.instance.unmount();
      for (const notice of notices) clearTimeout(notice.timer);
      clear.mockRestore(); schedule.mockRestore(); execute.mockRestore(); boundary.busy = false;
    }
  });

  it("clears the queued notice timeout when unmounted", async () => {
    boundary.busy = true;
    const ui = await mount();
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      await boundary.handleSubmit!("/job");
      const index = schedule.mock.calls.findIndex(call => call[1] === 18_000);
      expect(index).toBeGreaterThanOrEqual(0);
      const timer = schedule.mock.results[index]!.value;
      ui.instance.unmount();
      expect(clear).toHaveBeenCalledWith(timer);
    } finally { ui.instance.unmount(); clear.mockRestore(); schedule.mockRestore(); boundary.busy = false; }
  });

  it.each(["paused", "worker-attached"])("keeps inspection immediate but settings queued while %s", async state => {
    boundary.busy = true;
    boundary.paused = state === "paused";
    boundary.workerAttached = state === "worker-attached";
    boundary.intervene.mockReset();
    const execute = vi.spyOn(CommandRegistry.prototype, "execute").mockImplementation(async input => ({ type: "message", text: `Executed ${input}` }));
    const ui = await mount();
    try {
      await boundary.handleSubmit!("/permission auto-accept");
      await boundary.handleSubmit!("/job list");
      await boundary.handleSubmit!("/branch");
      await vi.waitFor(() => expect(ui.output()).toContain("Executed /branch"));
      expect(execute.mock.calls.map(call => call[0])).toEqual(["/job list", "/branch"]);
      expect(boundary.intervene).not.toHaveBeenCalled();
      expect(ui.output()).toContain("Queued 1");
    } finally {
      ui.instance.unmount(); execute.mockRestore();
      boundary.busy = false; boundary.paused = false; boundary.workerAttached = false;
    }
  });

  it("allows inspection during pending preparation without releasing its ownership", async () => {
    boundary.busy = false;
    let finish!: (accepted: boolean) => void;
    boundary.submit.mockReset().mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve; }));
    const execute = vi.spyOn(CommandRegistry.prototype, "execute").mockImplementation(async input => ({ type: "message", text: `Executed ${input}` }));
    const ui = await mount();
    try {
      const preparing = boundary.handleSubmit!("preparing");
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      await boundary.handleSubmit!("/model");
      await boundary.handleSubmit!("/job list");
      await boundary.handleSubmit!("/branch");
      await vi.waitFor(() => expect(ui.output()).toContain("Executed /branch"));
      expect(execute.mock.calls.map(call => call[0])).toEqual(["/job list", "/branch"]);
      // A handler's approval fallback must not open a manager during preparation.
      expect(execute.mock.calls[0]![1].isLoading).toBe(true);
      expect(boundary.submit).toHaveBeenCalledTimes(1);
      boundary.busy = true;
      finish(true); await preparing;
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledWith("/model", expect.anything()));
      expect(execute.mock.calls.map(call => call[0])).toEqual(["/job list", "/branch", "/model"]);
    } finally { finish?.(false); ui.instance.unmount(); execute.mockRestore(); boundary.busy = false; }
  });

  it("queues slash text with attachments as a model submission rather than bypassing the worker", async () => {
    boundary.busy = true;
    boundary.submit.mockReset().mockResolvedValue(true);
    const execute = vi.spyOn(CommandRegistry.prototype, "execute");
    const ui = await mount();
    try {
      boundary.promptProps.onPaste("attached context without credentials".repeat(8), () => {});
      // onPaste updates React state; wait for the fresh submit closure.
      ui.rerender();
      await new Promise(resolve => setTimeout(resolve, 60));
      await boundary.handleSubmit!("/job list");
      await vi.waitFor(() => expect(ui.output()).toContain("Queued /job: Cannot run this command in the current state."));
      expect(execute).not.toHaveBeenCalled();
      expect(boundary.submit).not.toHaveBeenCalled();
      boundary.busy = false; ui.rerender();
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      expect(boundary.submit.mock.calls[0]![0]).toBe("/job list");
      expect(boundary.submit.mock.calls[0]![1]).toEqual([expect.objectContaining({ type: "text", text: "attached context without credentials".repeat(8) })]);
      expect(execute).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); execute.mockRestore(); boundary.busy = false; }
  });

  it("allows inspection but prevents UI fallback during direct shell work", async () => {
    boundary.busy = false;
    boundary.submit.mockReset().mockResolvedValue(true);
    let finish!: (value: Awaited<ReturnType<typeof sandbox.runInSandbox>>) => void;
    const run = vi.spyOn(sandbox, "runInSandbox").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const execute = vi.spyOn(CommandRegistry.prototype, "execute").mockImplementation(async input => ({ type: "message", text: `Executed ${input}` }));
    const ui = await mount();
    try {
      const shell = boundary.handleSubmit!("!echo held-shell");
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      await boundary.handleSubmit!("/job");
      await boundary.handleSubmit!("/job list");
      await boundary.handleSubmit!("/branch");
      expect(execute.mock.calls.map(call => call[0])).toEqual(["/job list", "/branch"]);
      expect(execute.mock.calls[0]![1].isLoading).toBe(true);
      expect(boundary.submit).not.toHaveBeenCalled();
      finish({ stdout: "held-shell", stderr: "", error: null } as Awaited<ReturnType<typeof sandbox.runInSandbox>>);
      await shell;
      await vi.waitFor(() => expect(execute).toHaveBeenCalledWith("/job", expect.anything()));
      expect(boundary.submit).toHaveBeenCalledTimes(1);
    } finally {
      finish?.({ stdout: "", stderr: "", error: null } as Awaited<ReturnType<typeof sandbox.runInSandbox>>);
      ui.instance.unmount(); run.mockRestore(); execute.mockRestore(); boundary.busy = false;
    }
  });

  it("executes disruptive commands normally when idle without queue feedback", async () => {
    boundary.busy = false;
    const execute = vi.spyOn(CommandRegistry.prototype, "execute").mockResolvedValue({ type: "message", text: "Executed while idle" });
    const ui = await mount();
    try {
      for (const input of ["/model", "/effort high", "/permission ask", "/job", "/branch experiment"]) {
        await boundary.handleSubmit!(input);
        expect(execute).toHaveBeenCalledWith(input, expect.anything());
      }
      await vi.waitFor(() => expect(ui.output()).toContain("Executed while idle"));
      expect(ui.output()).not.toContain("Queued 1");
      expect(ui.output()).not.toContain("Waiting for idle.");
    } finally { ui.instance.unmount(); execute.mockRestore(); }
  });

  it("resolves configured detach before consent guards without waiting for the hint", async () => {
    boundary.canDetach = true;
    boundary.confirmation = { toolName: "write_file", input: {}, resolve: vi.fn() };
    boundary.detach.mockReset().mockRejectedValue(new Error("fixture detach failure"));
    const ui = await mount({ ...DEFAULT_KEYBINDINGS, detachSession: ["ctrl+k ctrl+e"] });
    try {
      expect(ui.output()).not.toContain("Ctrl+K Ctrl+E: detach");
      ui.stdin.emit("data", "\x18");
      await new Promise(r => setTimeout(r, 30));
      expect(boundary.detach).not.toHaveBeenCalled();
      ui.stdin.emit("data", "\x0b");
      await new Promise(r => setTimeout(r, 30));
      expect(boundary.detach).not.toHaveBeenCalled();
      ui.stdin.emit("data", "\x05");
      await vi.waitFor(() => expect(boundary.detach).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(ui.output()).toContain("fixture detach failure"));
    } finally { boundary.canDetach = false; boundary.confirmation = undefined; ui.instance.unmount(); }
  });

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
      await vi.waitFor(() => expect(ui.output()).toContain("› 1. first queued"));
      ui.stdin.emit("data", Buffer.from("\x1b[B"));
      // Wait for selection to commit before Delete; fixed sleeps race under load.
      await vi.waitFor(() => expect(ui.output()).toContain("› 2. middle queued"));
      ui.stdin.emit("data", Buffer.from("\x7f"));
      await vi.waitFor(() => expect(ui.output()).toContain("› 2. last queued"));
      ui.stdin.emit("data", Buffer.from("\x1b"));
      await vi.waitFor(() => expect(boundary.promptProps.disabled).toBe(false));
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

  it("runs metadata and snapshot commands mid-turn but queues the memory manager", async () => {
    boundary.busy = true;
    boundary.submit.mockReset();
    const ui = await mount();
    try {
      // Empty /name displays usage without needing session persistence in this fixture.
      await boundary.handleSubmit!("/name");
      await vi.waitFor(() => expect(ui.output()).toContain("Usage: /name <session name>"));
      await boundary.handleSubmit!("/copy");
      await vi.waitFor(() => expect(ui.output()).toContain("Nothing to copy"));
      expect(ui.output()).not.toContain("Queued 1");
      await boundary.handleSubmit!("/memory");
      await vi.waitFor(() => expect(ui.output()).toContain("Queued 1"));
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
