import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { AgavConfig } from "../config/config.js";

const boundary = vi.hoisted(() => ({ busy: false, cancel: vi.fn(), submit: vi.fn() }));
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../config/prompt-history.js", () => ({ loadPromptHistory: async () => [], savePromptHistory: vi.fn() }));
vi.mock("../hooks/use-agent.js", () => ({ useAgent: () => ({
  messages: [], isLoading: boundary.busy, toolCalls: [], subagentStates: [], loadedPlugins: [], mcpServers: [],
  mcpPromptCommands: [], skillCommands: [], agentCommands: [], tokenUsage: { inputTokens: 0, outputTokens: 0 },
  conversation: { getMessages: () => [] }, submit: boundary.submit, cancel: boundary.cancel,
}) }));

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 0, permissionMode: "ask" };
async function mount() {
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 24,
    write: () => true }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => stdin,
    resume: () => stdin, pause: () => stdin, read: () => null }) as unknown as NodeJS.ReadStream;
  const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 80)); await instance.waitUntilRenderFlush(); };
  await settle();
  return { instance, stdin, key: async (key: string) => { stdin.emit("data", Buffer.from(key)); await settle(); } };
}

beforeEach(() => { boundary.busy = false; boundary.cancel.mockReset(); boundary.submit.mockReset().mockResolvedValue(true); });

describe("interactive Ctrl+C", () => {
  it.each(["\x03", "\x1b[99;5u", "\x1b[3;5u"])("keeps an idle session and draft usable after repeated %j", async key => {
    const ui = await mount();
    try {
      await ui.key("keep this draft");
      await ui.key(key);
      await ui.key(key);
      expect(ui.stdin.listenerCount("data")).toBe(1);
      expect(boundary.cancel).not.toHaveBeenCalled();
      await ui.key("\r");
      expect(boundary.submit).toHaveBeenCalledWith("keep this draft", [], undefined, undefined, undefined);
    } finally { ui.instance.unmount(); }
  });

  it("still cancels an active turn without closing the UI", async () => {
    boundary.busy = true;
    const ui = await mount();
    try {
      await ui.key("\x03");
      expect(boundary.cancel).toHaveBeenCalledTimes(1);
      expect(ui.stdin.listenerCount("data")).toBe(1);
    } finally { ui.instance.unmount(); }
  });

  it.each(["\x11", "/exit"])("still quits explicitly with %j after idle Ctrl+C", async key => {
    const ui = await mount();
    try {
      await ui.key("\x03");
      expect(ui.stdin.listenerCount("data")).toBe(1);
      await ui.key(key);
      if (key === "/exit") await ui.key("\r");
      expect(ui.stdin.listenerCount("data")).toBe(0);
    } finally { ui.instance.unmount(); }
  });
});
