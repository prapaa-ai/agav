import { EventEmitter } from "node:events";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { useAgent } from "../hooks/use-agent.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";

vi.mock("../config/history.js", () => ({ saveSession: vi.fn(async () => "session") }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(), loadPlan: vi.fn(async () => null), clearPlan: vi.fn(), isPlanActive: (plan: unknown) => !!plan, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));
import { loadPlan } from "../agent/planner.js";

async function harness(provider: LLMProvider, maxIterations: number) {
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  let agent: ReturnType<typeof useAgent>;
  function App() {
    agent = useAgent(provider, { provider: "ollama", model: "mock", effort: "low", maxTokens: 1000, maxIterations, errorRetries: 0, permissionMode: "auto-accept" });
    return null;
  }
  const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await instance.waitUntilRenderFlush();
  return { instance, getAgent: () => agent! };
}

describe("interactive prompt budget lifecycle", () => {
  it("refreshes the exhausted allowance for independent user prompts", async () => {
    const stream = vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> { yield { type: "text_delta", text: "done" }; })());
    const { instance, getAgent } = await harness({ name: "mock", stream }, 1);
    try {
      for (const count of [1, 2]) {
        expect(await getAgent().submit("inspect")).toBe(true);
        await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(count));
        await vi.waitFor(() => expect(getAgent().isLoading).toBe(false));
        expect(getAgent().iterationsBudget).toEqual({ remaining: 0, total: 1 });
      }
    } finally { instance.unmount(); }
  });

  it("retains allowance through the automatic plan continuation scheduler", async () => {
    const stream = vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> { yield { type: "text_delta", text: "done" }; })());
    const { instance, getAgent } = await harness({ name: "mock", stream }, 2);
    try {
      vi.mocked(loadPlan).mockResolvedValue({ goal: "inspect", createdAt: new Date().toISOString(), currentStep: 1, steps: [{ id: 1, title: "Inspect", description: "inspect", status: "pending" }] });
      expect(await getAgent().submit("inspect")).toBe(true);
      await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(getAgent().messages.some(message => message.isError && message.content.includes("maximum iterations"))).toBe(true));
      expect(getAgent().iterationsBudget).toEqual({ remaining: 0, total: 2 });
      expect(stream).toHaveBeenCalledTimes(2);
      expect(getAgent().messages.filter(message => message.role === "user").length).toBeGreaterThan(1);
    } finally { vi.mocked(loadPlan).mockResolvedValue(null); instance.unmount(); }
  });
});
