import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { DisplayMessage } from "../components/message-list.js";
import type { AgavConfig } from "../config/config.js";

const boundary = vi.hoisted(() => ({ submit: vi.fn(), cancel: vi.fn(), handleSubmit: undefined as undefined | ((value: string) => Promise<void>), busy: false }));
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../components/input-prompt.js", () => ({ default: (props: any) => { boundary.handleSubmit = props.onSubmit; return null; } }));
vi.mock("../hooks/use-agent.js", () => ({ useAgent: () => {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  return {
    messages, isLoading: boundary.busy, toolCalls: [], subagentStates: [], loadedPlugins: [], mcpServers: [],
    mcpPromptCommands: [], skillCommands: [], agentCommands: [], tokenUsage: { inputTokens: 0, outputTokens: 0 },
    conversation: { getMessages: () => [] }, submit: boundary.submit,
    addDisplayMessage: (message: DisplayMessage) => setMessages(prev => [...prev, message]),
    cancel: boundary.cancel,
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

describe.skipIf(process.platform === "win32")("App shell execution (real subprocesses)", () => {
  it("shows responsive execution UI and raw stdout/stderr even if analysis cannot start", async () => {
    boundary.busy = false;
    boundary.submit.mockReset().mockResolvedValue(false);
    const ui = await mount();
    try {
      const pending = boundary.handleSubmit!("!sleep 0.2; printf 'first\\nlast\\n'; printf 'stderr\\n' >&2");
      await vi.waitFor(() => expect(ui.output()).toContain("Shell · $"));
      await pending;
      await vi.waitFor(() => expect(ui.output()).toContain("Shell output"));
      expect(ui.output()).toContain("first\nlast\nstderr");
      expect(boundary.submit).toHaveBeenCalledWith(expect.stringContaining("first\nlast\nstderr\n"), undefined, expect.stringContaining("! sleep"), [expect.objectContaining({ content: "first\nlast\nstderr\n", isError: false, toolName: "shell" })], undefined);
    } finally { ui.instance.unmount(); }
  });

  it("stops shell UI and routes Escape to agent cancellation while analysis is pending", async () => {
    boundary.busy = false;
    boundary.cancel.mockReset();
    let resolveSubmit!: (accepted: boolean) => void;
    const analysis = new Promise<boolean>(resolve => { resolveSubmit = resolve; });
    boundary.submit.mockReset().mockReturnValue(analysis);
    const ui = await mount();
    let pending: Promise<void> | undefined;
    let settled = false;
    try {
      pending = boundary.handleSubmit!("!sleep 0.2; printf done");
      void pending.then(() => { settled = true; });
      await vi.waitFor(() => expect(ui.output()).toContain("Shell · $"));
      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      boundary.busy = true;
      ui.rerender();
      await vi.waitFor(() => expect(ui.frame()).not.toContain("Shell · $"));
      expect(settled).toBe(false);
      ui.stdin.emit("data", Buffer.from("\x1b"));
      await vi.waitFor(() => expect(boundary.cancel).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
    } finally {
      resolveSubmit(true);
      await pending;
      boundary.busy = false;
      ui.instance.unmount();
    }
  });

  it("retains command failure and output in the separate result", async () => {
    boundary.submit.mockReset().mockResolvedValue(true);
    const ui = await mount();
    try {
      await boundary.handleSubmit!("!printf partial; exit 7");
      expect(boundary.submit.mock.calls[0]![3]).toEqual([expect.objectContaining({ content: "partial\nCommand exited with code 7", isError: true })]);
    } finally { ui.instance.unmount(); }
  });

  it("does not execute shell commands while an agent turn is busy or for a bare !", async () => {
    boundary.busy = true;
    boundary.submit.mockReset();
    const ui = await mount();
    try {
      await boundary.handleSubmit!("!printf should-not-run");
      await boundary.handleSubmit!("!   ");
      expect(boundary.submit).not.toHaveBeenCalled();
      expect(ui.output()).not.toContain("should-not-run");
    } finally { boundary.busy = false; ui.instance.unmount(); }
  });

  it("cancels a shell command without starting LLM analysis", async () => {
    boundary.submit.mockReset().mockResolvedValue(true);
    const ui = await mount();
    try {
      const pending = boundary.handleSubmit!("!sleep 2");
      await vi.waitFor(() => expect(ui.output()).toContain("Shell · $"));
      ui.stdin.emit("data", Buffer.from("\x1b"));
      await pending;
      expect(boundary.submit).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(ui.output()).toContain("Command cancelled."));
    } finally { ui.instance.unmount(); }
  });
});
