import { EventEmitter } from "node:events";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { useAgent } from "../hooks/use-agent.js";
import { RetryProvider } from "../providers/retry.js";
import type { LLMProvider } from "../providers/types.js";

// Isolate the UI boundary while exercising the real retry timer/AbortError.
vi.mock("../agent/loop.js", () => ({ runAgentLoop: async function* (params: any) {
  try {
    for await (const event of params.provider.stream({ model: params.model, messages: [], signal: params.signal })) {
      if (event.type !== "error") yield event;
    }
  } catch (error) {
    yield { type: "error", error };
  }
} }));
vi.mock("../config/history.js", () => ({ saveSession: vi.fn() }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn() }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(), loadPlan: async () => null, clearPlan: vi.fn(), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));

describe("useAgent cancellation", () => {
  it("does not show a hard error when retry backoff is cancelled", async () => {
    let attempts = 0;
    const inner: LLMProvider = { name: "mock", stream: async function* () {
      attempts++;
      throw Object.assign(new Error("Rate limited"), { status: 429 });
    } };
    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
    let agent: ReturnType<typeof useAgent>;
    const provider = new RetryProvider(inner);
    function App() {
      agent = useAgent(provider, { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 1, permissionMode: "auto-accept" });
      return null;
    }
    const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    try {
      await instance.waitUntilRenderFlush();
      await agent!.submit("hello");
      await vi.waitFor(() => expect(attempts).toBe(1));
      agent!.cancel();
      await vi.waitFor(() => expect(agent!.isLoading).toBe(false));
      expect(attempts).toBe(1);
      expect(agent!.messages.filter(message => message.isError)).toEqual([]);
    } finally {
      instance.unmount();
    }
  });
});
