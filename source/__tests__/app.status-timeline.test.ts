import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import { clearSteers, drainSteers, getActiveSteers } from "../commands/steer.js";
import type { DisplayMessage } from "../components/message-list.js";
import type { AgavConfig } from "../config/config.js";
import type { Plan } from "../agent/planner.js";
import type { SubagentProgress } from "../agent/subagent-types.js";
import type { CommandContext } from "../commands/types.js";

type AgentState = {
  messages: DisplayMessage[];
  streamingText: string;
  isLoading: boolean;
  subagentStates: SubagentProgress[];
  activePlan: Plan | null;
};

const boundary = vi.hoisted(() => ({
  initial: {} as Partial<AgentState>,
  submit: undefined as undefined | ((text: string) => Promise<void>),
  append: undefined as undefined | ((message: DisplayMessage) => void),
  update: undefined as undefined | ((patch: Partial<AgentState>) => void),
  refreshPlan: vi.fn(),
  planExecute: vi.fn(),
}));
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../components/input-prompt.js", () => ({ default: (props: { onSubmit: (text: string) => Promise<void> }) => {
  boundary.submit = props.onSubmit;
  return null;
} }));
vi.mock("../commands/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/plan.js")>();
  return { ...actual, planCommand: { ...actual.planCommand, execute: boundary.planExecute } };
});
vi.mock("../hooks/use-agent.js", () => ({ useAgent: vi.fn(() => {
  const [state, setState] = useState<AgentState>(() => ({
    messages: [], streamingText: "Live progress", isLoading: true,
    subagentStates: [], activePlan: null, ...boundary.initial,
  }));
  boundary.append = (message) => setState(prev => ({ ...prev, messages: [...prev.messages, message] }));
  boundary.update = (patch) => setState(prev => ({ ...prev, ...patch }));
  return {
    ...state, thinkingText: "", toolCalls: [], loadedPlugins: [], mcpServers: [],
    mcpPromptCommands: [], skillCommands: [], agentCommands: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0 }, conversation: {},
    addDisplayMessage: boundary.append, refreshPlan: boundary.refreshPlan,
  };
}) }));

const config: AgavConfig = {
  provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000,
  maxIterations: 2, errorRetries: 0, permissionMode: "ask",
};

// Capture the last text-bearing terminal paint, never the accumulated scrollback.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
async function mount(initial: Partial<AgentState> = {}) {
  boundary.initial = initial;
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, {
    isTTY: true, columns: 100, rows: 70,
    write: (text: string) => { chunks.push(text); return true; },
  });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true, setRawMode: () => stdin, resume: () => stdin,
    pause: () => stdin, read: () => null,
  });
  const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  });
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    await instance.waitUntilRenderFlush();
  };
  const frame = () => chunks.map(stripAnsi).filter(text => /[a-z]/i.test(text)).at(-1) ?? "";
  const key = async (text: string) => {
    stdin.emit("data", Buffer.from(text));
    await settle();
  };
  const submit = async (text: string) => { await boundary.submit!(text); await settle(); };
  const append = async (...messages: DisplayMessage[]) => {
    for (const message of messages) boundary.append!(message);
    await settle();
  };
  const update = async (patch: Partial<AgentState>) => { boundary.update!(patch); await settle(); };
  await settle();
  return { instance, frame, key, submit, append, update };
}

// Presence and multiplicity checks are essential: indexOf alone accepts missing
// earlier entries (-1) and does not catch a second copy rendered below the tail.
function expectTimeline(frame: string, entries: string[]) {
  for (const entry of entries) expect(frame.split(entry), `Expected exactly one ${JSON.stringify(entry)} in last frame:\n${frame}`).toHaveLength(2);
  for (let i = 1; i < entries.length; i++) {
    expect(frame.indexOf(entries[i - 1]!)).toBeLessThan(frame.indexOf(entries[i]!));
  }
}

const completedTool = (id: string, content: string): DisplayMessage => ({
  id, role: "tool", toolName: "read_file", toolInput: { path: "source/app.tsx" }, content,
});
const progress = (id: string): SubagentProgress => ({
  id, title: `${id} worker`, task: "Inspect timeline ordering", status: "running",
  toolCalls: [], thinkingText: "", streamingText: "", startedAt: Date.now(), totalToolCalls: 0,
  tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
});
const makePlan = (): Plan => ({
  goal: "Validate timeline ordering", createdAt: "2026-01-01T00:00:00.000Z", currentStep: 0,
  steps: [
    { id: 1, title: "Inspect transcript", description: "Read the render path", status: "pending" },
    { id: 2, title: "Verify terminal frames", description: "Run regressions", status: "pending" },
  ],
});

const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
beforeEach(() => {
  // App reads process.stdout for its initial dimensions, independently of the
  // injected Ink stream. Keep the entire fixture visible in one latest frame.
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: 70 });
  vi.clearAllMocks();
  clearSteers();
  boundary.initial = {};
  boundary.submit = undefined;
  boundary.append = undefined;
  boundary.update = undefined;
  boundary.planExecute.mockReset();
});

afterEach(() => {
  if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
  else Reflect.deleteProperty(process.stdout, "rows");
  clearSteers();
});

describe("command status timeline", () => {
  it("keeps multiple steer submissions and deliveries before later completed tools and replies", async () => {
    const ui = await mount();
    try {
      await ui.submit("/steer Check edge cases");
      await ui.submit("/steer Verify ordering");
      expect(getActiveSteers()).toEqual(["Check edge cases", "Verify ordering"]);
      await ui.append({ id: "delivery-1", role: "system", content: "Delivered 2 steers to the running agent." });
      // Simulate the safe-point queue drain without clearing persistent steers.
      expect(drainSteers()).toEqual(["Check edge cases", "Verify ordering"]);
      await ui.append(
        completedTool("tool-1", "First completed tool output"),
        { id: "reply-1", role: "assistant", content: "First completed reply" },
      );
      const firstCycle = [
        'Steer added: "Check edge cases"', 'Steer added: "Verify ordering"',
        "Delivered 2 steers", "First completed tool output", "First completed reply",
      ];
      expectTimeline(ui.frame(), [...firstCycle, "Live progress"]);

      await ui.submit("/steer Finish validation");
      await ui.append(
        { id: "delivery-2", role: "system", content: "Delivered 1 steer to the running agent." },
        completedTool("tool-2", "Second completed tool output"),
        { id: "reply-2", role: "assistant", content: "Second completed reply" },
      );
      const timeline = [...firstCycle, 'Steer added: "Finish validation"',
        "Delivered 1 steer", "Second completed tool output", "Second completed reply"];
      expectTimeline(ui.frame(), [...timeline, "Live progress"]);
      expect(ui.frame().match(/Steer added/g)).toHaveLength(3);
      await ui.update({ isLoading: false, streamingText: "" });
      expectTimeline(ui.frame(), timeline);
      expect(ui.frame()).not.toContain("Live progress");
    } finally { ui.instance.unmount(); }
  });

  it("does not duplicate or move statuses when running subagents update in overview and focused views", async () => {
    const first = progress("first");
    const second = progress("second");
    const ui = await mount({ subagentStates: [first, second] });
    try {
      await ui.submit("/steer Preserve status position");
      await ui.append(
        { id: "delivery", role: "system", content: "Delivered 1 steer to the running agent." },
        { id: "child-delivery-1", role: "system", content: 'Delivered 1 steer to subagent "Parser inspection".' },
        { id: "child-delivery-2", role: "system", content: 'Delivered 1 steer to subagent "Test review".' },
        completedTool("tool", "Overview completed tool output"),
        { id: "reply", role: "assistant", content: "Overview completed reply" },
      );
      const timeline = ['Steer added: "Preserve status position"', "Delivered 1 steer to the running agent.",
        'Delivered 1 steer to subagent "Parser inspection".', 'Delivered 1 steer to subagent "Test review".',
        "Overview completed tool output", "Overview completed reply"];
      expectTimeline(ui.frame(), [...timeline, "first worker", "second worker", "Live progress"]);
      expect(ui.frame()).toContain("Enter: inspect");
      await ui.update({ subagentStates: [{ ...first, totalToolCalls: 2 }, second] });
      expectTimeline(ui.frame(), [...timeline, "first worker", "second worker", "Live progress"]);
      expect(ui.frame()).toContain("2 tools");

      await ui.key("\r");
      expectTimeline(ui.frame(), [...timeline, "first worker", "Inspect timeline ordering"]);
      expect(ui.frame()).toContain("Tab: back to overview");
      expect(ui.frame()).not.toContain("second worker");
      expect(ui.frame()).not.toContain("Live progress");
      await ui.update({ subagentStates: [{ ...first, streamingText: "Focused subagent update" }, second] });
      expectTimeline(ui.frame(), [...timeline, "first worker", "Focused subagent update"]);
      await ui.append({ id: "focused-reply", role: "assistant", content: "Completed while focused" });
      expectTimeline(ui.frame(), [...timeline, "Completed while focused", "first worker", "Focused subagent update"]);

      await ui.key("\t");
      expectTimeline(ui.frame(), [...timeline, "Completed while focused", "first worker", "second worker", "Live progress"]);
      expect(ui.frame()).not.toContain("Focused subagent update");
      expect(ui.frame()).toContain("Enter: inspect");
    } finally { ui.instance.unmount(); }
  });

  it("renders a DisplayMessage plan once in its timeline slot and updates step statuses in place", async () => {
    const plan = makePlan();
    const planMessage: DisplayMessage = { id: "plan", role: "system", content: "Hidden plan fallback", plan };
    const before: DisplayMessage = { id: "before", role: "assistant", content: "Before plan creation" };
    const tool = completedTool("after-tool", "Tool after plan creation");
    const after: DisplayMessage = { id: "after", role: "assistant", content: "Reply after plan creation" };
    const ui = await mount({ messages: [before, planMessage], activePlan: plan });
    try {
      await ui.append(tool, after);
      const timeline = ["Before plan creation", "Plan: Validate timeline ordering", "Step 1: Inspect transcript",
        "Step 2: Verify terminal frames", "Tool after plan creation", "Reply after plan creation", "Live progress"];
      expectTimeline(ui.frame(), timeline);
      expect(ui.frame()).toContain("○ Step 1: Inspect transcript");
      expect(ui.frame()).toContain("○ Step 2: Verify terminal frames");
      expect(ui.frame()).not.toContain("Hidden plan fallback");

      for (const status of ["in_progress", "done"] as const) {
        const updated: Plan = { ...plan, steps: plan.steps.map(step => step.id === 1 ? { ...step, status } : step) };
        await ui.update({ messages: [before, { ...planMessage, plan: updated }, tool, after], activePlan: updated });
        expectTimeline(ui.frame(), timeline);
        expect(ui.frame()).toContain(`${status === "done" ? "✓" : "◉"} Step 1: Inspect transcript`);
        expect(ui.frame()).not.toContain("○ Step 1: Inspect transcript");
        expect(ui.frame()).toContain("○ Step 2: Verify terminal frames");
        expect(ui.frame()).not.toContain("Hidden plan fallback");
      }
      expect(ui.frame()).toContain("1/2 complete");
    } finally { ui.instance.unmount(); }
  });

  it("keeps a /plan command acknowledgement before subsequent events and later commands", async () => {
    boundary.planExecute.mockImplementation(async (args: string, context: CommandContext) => {
      expect(args).toBe("1 done");
      context.refreshPlan();
      return { type: "message", text: "Step 1 marked done. Progress: 1/2 steps done." };
    });
    // /plan is intentionally unavailable mid-turn; acknowledge it while idle,
    // then start the mocked turn to verify the acknowledgement stays anchored.
    const ui = await mount({ isLoading: false, streamingText: "" });
    try {
      await ui.submit("/plan 1 done");
      expect(boundary.planExecute).toHaveBeenCalledTimes(1);
      expect(boundary.refreshPlan).toHaveBeenCalledTimes(1);
      await ui.update({ isLoading: true, streamingText: "Live progress" });
      await ui.append(
        completedTool("after-plan-tool", "Completed tool after plan command"),
        { id: "after-plan-reply", role: "assistant", content: "Completed reply after plan command" },
      );
      const timeline = ["Step 1 marked done. Progress: 1/2 steps done.",
        "Completed tool after plan command", "Completed reply after plan command"];
      expectTimeline(ui.frame(), [...timeline, "Live progress"]);
      await ui.submit("/steer Check plan completion");
      expectTimeline(ui.frame(), [...timeline, 'Steer added: "Check plan completion"', "Live progress"]);
      await ui.update({ isLoading: false, streamingText: "" });
      expectTimeline(ui.frame(), [...timeline, 'Steer added: "Check plan completion"']);
    } finally { ui.instance.unmount(); }
  });
});
