import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { AgavConfig } from "../config/config.js";

const boundary = vi.hoisted(() => ({
  submit: vi.fn(),
  largePaste: undefined as ((text: string) => void) | undefined,
  busy: false,
}));

vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../hooks/use-paste-handler.js", () => ({
  useClipboardImageDetector: (
    _onImage: unknown,
    _enabled: unknown,
    onLargePaste?: (text: string) => void,
  ) => {
    boundary.largePaste = onLargePaste;
  },
}));
vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: vi.fn(),
}));
vi.mock("../config/history.js", () => ({ saveSession: vi.fn(async () => "session") }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({
  refreshStableContext: async () => "",
  refreshVolatileContext: async () => ({ context: "" }),
  formatTurnContext: () => "",
}));
vi.mock("../agent/planner.js", () => ({
  shouldAutoPlan: () => false,
  savePlan: vi.fn(async () => {}),
  loadPlan: async () => null,
  clearPlan: vi.fn(async () => {}),
  isPlanActive: () => false,
  setPlanScope: vi.fn(),
  adoptPlanScope: vi.fn(),
  prunePlans: async () => {},
  formatPlanForPrompt: () => "",
  ensurePlanFile: async () => {},
}));
vi.mock("../hooks/use-agent.js", () => ({
  useAgent: () => ({
    messages: [],
    isLoading: boundary.busy,
    toolCalls: [],
    subagentStates: [],
    loadedPlugins: [],
    mcpServers: [],
    mcpPromptCommands: [],
    skillCommands: [],
    agentCommands: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    pendingConfirmation: null,
    conversation: { getMessages: () => [] },
    submit: boundary.submit,
    cancel: vi.fn(),
  }),
}));

const config: AgavConfig = {
  provider: "anthropic",
  model: "mock",
  effort: "low",
  maxTokens: 1000,
  maxIterations: 2,
  errorRetries: 1,
  permissionMode: "ask",
};

async function mount() {
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 24,
    write: (text: string) => {
      chunks.push(text);
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => null,
  }) as unknown as NodeJS.ReadStream;
  const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await instance.waitUntilRenderFlush();
  };
  await settle();
  return { instance, stdin, settle };
}

describe("App attachment removal submission", () => {
  beforeEach(() => {
    boundary.submit.mockReset().mockResolvedValue(true);
    boundary.largePaste = undefined;
    boundary.busy = false;
  });

  it("excludes a removed attachment when Delete and Enter arrive in the same read", async () => {
    const ui = await mount();
    try {
      const payload1 = "payload one\nline2\nline3\nline4\nline5";
      const payload2 = "payload two\nline2\nline3\nline4\nline5";
      boundary.largePaste!(payload1);
      await ui.settle();
      boundary.largePaste!(payload2);
      await ui.settle();

      // Move caret to position 0 (before tile #1).
      for (let i = 0; i < 80; i++) {
        ui.stdin.emit("data", Buffer.from("\x1b[D"));
      }
      await ui.settle();

      // Send forward Delete and Enter in one terminal read without a render in between.
      ui.stdin.emit("data", Buffer.from("\x1b[3~\r"));

      await vi.waitFor(() => expect(boundary.submit).toHaveBeenCalledTimes(1));
      const [submittedText, submittedBlocks] = boundary.submit.mock.calls[0]!;
      expect(submittedText).toContain("#2");
      expect(submittedText).not.toContain("#1");
      expect(submittedBlocks).toEqual([{ type: "text", text: payload2 }]);
    } finally {
      ui.instance.unmount();
    }
  });
});
