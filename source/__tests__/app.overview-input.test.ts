import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { Text } from "../ink/index.js";
import App from "../app.js";
import { useAgent } from "../hooks/use-agent.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import { clearSteers, getActiveSteers } from "../commands/steer.js";
import type { AgavConfig } from "../config/config.js";
import type { SubagentProgress } from "../agent/subagent-types.js";

vi.mock("../hooks/use-agent.js", () => ({ useAgent: vi.fn() }));
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [], savePromptHistory: vi.fn(),
}));
const display = vi.hoisted(() => vi.fn());
vi.mock("../components/subagent-display.js", () => ({
  default: (props: { progress: SubagentProgress; mode: string }) => {
    display(props);
    return h(Text, null, `${props.mode}: ${props.progress.title}`);
  },
}));

const config: AgavConfig = {
  provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000,
  maxIterations: 2, errorRetries: 0, permissionMode: "auto-accept",
};
const progress = (id: string): SubagentProgress => ({
  id, title: id, task: "inspect code", status: "running", toolCalls: [],
  thinkingText: "", streamingText: "", startedAt: Date.now(), totalToolCalls: 0,
  tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
});

async function mount(title = "subagent", contextWindowPending = false) {
  const resolveContextWindowRequest = vi.fn();
  const interveneWhilePaused = vi.fn();
  vi.mocked(useAgent).mockReturnValue({
    messages: [], streamingText: "", thinkingText: "", isLoading: true,
    toolCalls: [], error: null, pendingConfirmation: null,
    pendingContextWindowRequest: contextWindowPending ? { model: "unknown" } : null,
    resolveContextWindowRequest,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    loadedPlugins: [], mcpServers: [], mcpPromptCommands: [], skillCommands: [], agentCommands: [],
    subagentStates: [progress(title), progress("second")], activePlan: null,
    conversation: {}, isGenerationPaused: true, interveneWhilePaused,
  } as unknown as ReturnType<typeof useAgent>);
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true, setRawMode: () => stdin, resume: () => stdin,
    pause: () => stdin, read: () => null,
  });
  const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  });
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await instance.waitUntilRenderFlush();
  };
  const key = async (text: string) => {
    stdin.emit("data", Buffer.from(text));
    await settle();
  };
  await settle();
  return { instance, key, stdin, settle, interveneWhilePaused, resolveContextWindowRequest };
}
const details = () => display.mock.calls.filter(([props]) => props.mode === "detail");

beforeEach(() => {
  vi.clearAllMocks();
  clearSteers();
});

describe("overview input routing", () => {
  it("keeps context-window input out of the chat prompt and task overview", async () => {
    const ui = await mount("subagent", true);
    try {
      await ui.key("32768");
      await ui.key("\r");
      expect(ui.resolveContextWindowRequest).toHaveBeenCalledExactlyOnceWith(32768);
      expect(ui.interveneWhilePaused).not.toHaveBeenCalled();
      expect(details()).toEqual([]);
    } finally { ui.instance.unmount(); }
  });

  it("does not inspect a task when typing and Enter arrive before a commit", async () => {
    const { instance, stdin, settle, interveneWhilePaused } = await mount();
    try {
      stdin.emit("data", Buffer.from("x"));
      stdin.emit("data", Buffer.from("\r"));
      await settle();
      expect(interveneWhilePaused).toHaveBeenCalledWith("x", undefined, undefined, undefined, undefined);
      expect(details()).toEqual([]);
    } finally { instance.unmount(); }
  });

  it("keeps a burst of typing, arrows and Enter out of the overview", async () => {
    const { instance, stdin, settle, key } = await mount();
    try {
      for (const key of ["x", "\x1b[B", "\r"]) stdin.emit("data", Buffer.from(key));
      await settle();
      expect(details()).toEqual([]);
      await key("\r");
      expect(details().at(-1)?.[0].progress.id).toBe("subagent");
    } finally { instance.unmount(); }
  });

  it.each(["subagent", "skill", "native agent"])("submits a prompt without inspecting a %s", async (title) => {
    const { instance, key, interveneWhilePaused } = await mount(title);
    try {
      await key("continue with tests");
      await key("\r");
      expect(interveneWhilePaused).toHaveBeenCalledWith("continue with tests", undefined, undefined, undefined, undefined);
      expect(details()).toEqual([]);
    } finally { instance.unmount(); }
  });

  it("executes a mid-turn command without inspecting a task", async () => {
    const { instance, key } = await mount();
    try {
      await key("/steer check edge cases");
      await key("\r");
      expect(getActiveSteers()).toEqual(["check edge cases"]);
      expect(details()).toEqual([]);
    } finally { instance.unmount(); }
  });

  it("keeps completion arrows and Enter out of the overview", async () => {
    const { instance, key } = await mount();
    try {
      await key("/st");
      await key("\x1b[B");
      await key("\r");
      expect(details()).toEqual([]);
      // Complete /steer, then clear the prompt. Completion must not have
      // moved the highlighted overview row to the second task.
      await key("\x15");
      await key("\r");
      expect(details().at(-1)?.[0].progress.id).toBe("subagent");
    } finally { instance.unmount(); }
  });

  it("still navigates, inspects and returns to overview with an empty prompt", async () => {
    const { instance, key, interveneWhilePaused } = await mount();
    try {
      await key("\x1b[B");
      await key("\r");
      expect(details().at(-1)?.[0].progress.id).toBe("second");
      expect(interveneWhilePaused).not.toHaveBeenCalled();
      await key("\t");
      await key("\x1b[A");
      await key("\r");
      expect(details().at(-1)?.[0].progress.id).toBe("subagent");
    } finally { instance.unmount(); }
  });

  it("does not inspect on Shift+Enter in an empty prompt", async () => {
    const { instance, key } = await mount();
    try {
      await key("\x1b[13;2u");
      expect(details()).toEqual([]);
    } finally { instance.unmount(); }
  });
});
