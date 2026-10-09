import { EventEmitter } from "node:events";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { useAgent } from "../hooks/use-agent.js";
import type { LLMProvider } from "../providers/types.js";
import type { Plan } from "../agent/planner.js";

const boundary = vi.hoisted(() => ({
  plan: null as Plan | null,
  budgets: [] as { remaining: number; total: number }[],
  allowances: [] as number[],
}));
// Observe budget identity while retaining the real loop's request/exhaustion behavior.
vi.mock("../agent/loop.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../agent/loop.js")>();
  return { ...original, runAgentLoop: async function* (params: Parameters<typeof original.runAgentLoop>[0]) {
    boundary.budgets.push(params.iterationsBudget!);
    boundary.allowances.push(params.iterationsBudget!.remaining);
    yield* original.runAgentLoop(params);
  } };
});
vi.mock("../config/history.js", () => ({ saveSession: vi.fn(async () => "session") }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(async () => {}), loadPlan: async () => boundary.plan, clearPlan: vi.fn(async () => {}), isPlanActive: (plan: Plan | null) => !!plan, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));

async function mount(complete = false, maxIterations = 1) {
  const stream = vi.fn(async function* () {
    if (complete) yield { type: "text_delta" as const, text: "done" };
    else {
      yield { type: "tool_call_start" as const, toolCallId: "call", toolName: "noop" };
      yield { type: "tool_call_delta" as const, toolCallId: "call", argsJson: "{}" };
    }
  });
  const provider: LLMProvider = { name: "mock", stream };
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  let agent!: ReturnType<typeof useAgent>;
  function App() {
    agent = useAgent(provider, { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations, errorRetries: 1, permissionMode: "auto-accept" });
    return null;
  }
  const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await instance.waitUntilRenderFlush();
  agent.toolRegistry.register({ schema: { name: "noop", description: "No-op", inputSchema: { type: "object", properties: {} } }, execute: async () => ({ output: "ok", isError: false }) });
  return { instance, stream, agent: () => agent };
}

describe("useAgent per-submission iteration budget", () => {
  beforeEach(() => {
    boundary.plan = null;
    boundary.budgets = [];
    boundary.allowances = [];
  });

  it.each([undefined, "! printf done", "custom display label", ""])("resets an exhausted allowance for a new submission labelled %j", async (label) => {
    const ui = await mount();
    try {
      expect(await ui.agent().submit("first prompt")).toBe(true);
      await vi.waitFor(() => expect(ui.agent().messages.map(message => message.content).join("\n")).toContain("maximum iterations"));
      expect(ui.stream).toHaveBeenCalledTimes(1);
      expect(ui.agent().iterationsBudget?.remaining).toBe(0);
      expect(await ui.agent().submit("new prompt or shell output", undefined, label)).toBe(true);
      await vi.waitFor(() => expect(boundary.allowances).toHaveLength(2));
      await vi.waitFor(() => expect(ui.agent().isLoading).toBe(false));
      expect(ui.stream).toHaveBeenCalledTimes(2);
      expect(boundary.allowances).toEqual([1, 1]);
      expect(boundary.budgets[1]).not.toBe(boundary.budgets[0]);
    } finally { ui.instance.unmount(); }
  });

  it("refreshes the exhausted allowance for independent user prompts", async () => {
    const ui = await mount(true);
    try {
      for (const count of [1, 2]) {
        expect(await ui.agent().submit("inspect")).toBe(true);
        await vi.waitFor(() => expect(ui.stream).toHaveBeenCalledTimes(count));
        await vi.waitFor(() => expect(ui.agent().isLoading).toBe(false));
        expect(ui.agent().iterationsBudget).toEqual({ remaining: 0, total: 1 });
      }
      expect(boundary.allowances).toEqual([1, 1]);
      expect(boundary.budgets[1]).not.toBe(boundary.budgets[0]);
    } finally { ui.instance.unmount(); }
  });

  it("retains allowance through the automatic plan continuation scheduler", async () => {
    boundary.plan = { goal: "inspect", createdAt: new Date().toISOString(), currentStep: 1, steps: [{ id: 1, title: "Inspect", description: "inspect", status: "pending" }] };
    const ui = await mount(true, 2);
    try {
      expect(await ui.agent().submit("inspect")).toBe(true);
      await vi.waitFor(() => expect(ui.stream).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(ui.agent().messages.some(message => message.isError && message.content.includes("maximum iterations"))).toBe(true));
      expect(ui.agent().iterationsBudget).toEqual({ remaining: 0, total: 2 });
      expect(ui.stream).toHaveBeenCalledTimes(2);
      expect(ui.agent().messages.filter(message => message.role === "user").length).toBeGreaterThan(1);
      expect(boundary.allowances).toEqual([2, 1, 0]);
      expect(boundary.budgets.every(budget => budget === boundary.budgets[0])).toBe(true);
    } finally { ui.instance.unmount(); }
  });

  it("retains the original allowance for planned-work auto-continuations", async () => {
    boundary.plan = { goal: "Finish work", createdAt: "2026-01-01", currentStep: 0, steps: [{ id: 1, title: "Work", description: "Work", status: "pending" }] };
    const ui = await mount(true);
    try {
      // Even the first submission may have a presentation label.
      expect(await ui.agent().submit("start work", undefined, "custom label")).toBe(true);
      await vi.waitFor(() => expect(ui.agent().messages.some(message => message.content.includes("maximum iterations"))).toBe(true));
      expect(ui.stream).toHaveBeenCalledTimes(1);
      expect(boundary.allowances).toEqual([1, 0]);
      expect(boundary.budgets[1]).toBe(boundary.budgets[0]);
      expect(ui.agent().iterationsBudget).toBe(boundary.budgets[0]);
      expect(ui.agent().messages.some(message => message.content === "▸ Plan step 1")).toBe(true);
    } finally { ui.instance.unmount(); }
  });
});
