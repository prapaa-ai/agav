import { EventEmitter } from "node:events";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { useAgent } from "../hooks/use-agent.js";
import type { Plan } from "../agent/planner.js";
import type { SessionRecord } from "../config/history.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { FileMentionExpansion } from "../utils/file-mentions.js";

const boundary = vi.hoisted(() => ({
  loadPlan: vi.fn<() => Promise<Plan | null>>(),
  expand: vi.fn<(text: string) => Promise<FileMentionExpansion>>(),
}));
// Mock disk/extension/context boundaries, not useAgent, ConversationState or runAgentLoop.
vi.mock("../config/history.js", () => ({ saveSession: vi.fn(async () => "saved-session") }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../skills/improvement.js", () => ({ maybeRunBackgroundImprovement: async () => {} }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../utils/file-mentions.js", () => ({ expandFileMentions: boundary.expand }));
vi.mock("../agent/planner.js", () => ({
  shouldAutoPlan: () => false, savePlan: vi.fn(async () => {}), loadPlan: boundary.loadPlan,
  clearPlan: vi.fn(async () => {}), isPlanActive: (plan: Plan | null) => !!plan,
  setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {},
  formatPlanForPrompt: () => "", ensurePlanFile: async () => {},
}));

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function expansion(text: string): FileMentionExpansion {
  return { expanded: text, displayText: text, files: [], contentBlocks: [], warnings: [] };
}
function pendingPlan(): Plan {
  return { goal: "Work", createdAt: "2026-01-01", currentStep: 0, steps: [{ id: 1, title: "Work", description: "Work", status: "pending" }] };
}
const otherSession: SessionRecord = {
  id: "other-session", createdAt: "2026-01-01", model: "mock", provider: "anthropic", title: "Other",
  messages: [{ role: "user", content: [{ type: "text", text: "other history" }], sourceText: "other history" }],
};

async function mount() {
  const calls: { params: StreamParams; finish: () => void }[] = [];
  let hold = false;
  const stream = vi.fn<LLMProvider["stream"]>(async function* (params) {
    const completion = gate<void>();
    calls.push({ params, finish: () => completion.resolve() });
    // An uncooperative iterator deliberately delays cleanup after abort.
    if (hold) await completion.promise;
    if (!params.signal?.aborted) yield { type: "text_delta", text: "done" };
  });
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const provider: LLMProvider = { name: "mock", stream };
  const config = { provider: "anthropic" as const, model: "mock", effort: "low" as const, maxTokens: 1000, maxIterations: 4, errorRetries: 1, permissionMode: "auto-accept" as const };
  let agent!: ReturnType<typeof useAgent>;
  function App() { agent = useAgent(provider, config); return null; }
  const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  // Keep React/Ink's setImmediate scheduler real; never advance the continuation clock while polling.
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 1000; i++) {
      await instance.waitUntilRenderFlush();
      if (predicate()) return;
    }
    throw new Error("Hook did not reach the expected state without advancing timers");
  }
  await instance.waitUntilRenderFlush();
  // Only timeouts are controlled: React/Ink can continue rendering between clock ticks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const stop = async () => {
    agent.cancel();
    calls.forEach(call => call.finish());
    await until(() => !agent.isLoading);
    instance.unmount();
  };
  return { agent: () => agent, calls, stream, timeout, until, stop, hold: () => { hold = true; } };
}
type UI = Awaited<ReturnType<typeof mount>>;
function userTexts(ui: UI) { return ui.agent().messages.filter(message => message.role === "user").map(message => message.content); }
function invalidate(ui: UI, action: string) {
  if (action === "cancel") ui.agent().cancel();
  else if (action === "clearMessages") ui.agent().clearMessages();
  else if (action === "loadSession") ui.agent().loadSession(otherSession);
  else ui.agent().activateSession("other-session");
}
async function scheduled(ui: UI) {
  await ui.until(() => !ui.agent().isLoading && ui.timeout.mock.calls.some(call => call[1] === 100));
}

beforeEach(() => {
  boundary.loadPlan.mockReset().mockResolvedValue(null);
  boundary.expand.mockReset().mockImplementation(async text => expansion(text));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("useAgent request lifecycle with the real loop", () => {
  it.each(["resolve", "reject"] as const)("cancels gated file expansion (%s), adds no history, and permits a later submit", async outcome => {
    const ui = await mount();
    const preparation = gate<FileMentionExpansion>();
    boundary.expand.mockImplementationOnce(() => preparation.promise);
    try {
      const pending = ui.agent().submit("@slow-file");
      await ui.until(() => ui.agent().isLoading);
      expect(await ui.agent().submit("competing prompt")).toBe(false);
      ui.agent().cancel();
      if (outcome === "resolve") preparation.resolve(expansion("expanded file"));
      else preparation.reject(new Error("late expansion failure"));
      expect(await pending).toBe(false);
      await ui.until(() => !ui.agent().isLoading);
      expect(ui.stream).not.toHaveBeenCalled();
      expect(ui.agent().conversation.getMessages()).toEqual([]);
      expect(ui.agent().messages).toEqual([]);
      expect(ui.agent().error).toBeNull();
      expect(await ui.agent().submit("later prompt")).toBe(true);
      await ui.until(() => ui.calls.length === 1 && !ui.agent().isLoading);
      expect(userTexts(ui)).toEqual(["later prompt"]);
      expect(ui.agent().conversation.getMessages().filter(message => message.role === "user").map(message => message.sourceText)).toEqual(["later prompt"]);
    } finally { preparation.resolve(expansion("released")); await ui.stop(); }
  });

  it("actually starts an untouched plan continuation at 100ms, not 99ms", async () => {
    const ui = await mount();
    boundary.loadPlan.mockResolvedValue(pendingPlan());
    try {
      expect(await ui.agent().submit("original")).toBe(true);
      await scheduled(ui);
      await vi.advanceTimersByTimeAsync(99);
      expect(ui.stream).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await ui.until(() => ui.calls.length === 2 && !ui.agent().isLoading);
      expect(userTexts(ui)).toEqual(["original", "▸ Plan step 1"]);
    } finally { await ui.stop(); }
  });

  it.each(["cancel", "clearMessages", "loadSession", "activateSession", "new prompt"])("invalidates an already scheduled continuation on %s", async action => {
    const ui = await mount();
    boundary.loadPlan.mockResolvedValue(pendingPlan());
    try {
      expect(await ui.agent().submit("original")).toBe(true);
      await scheduled(ui);
      await vi.advanceTimersByTimeAsync(99);
      // The new scope/turn has no plan: only the old timer could submit a step.
      boundary.loadPlan.mockResolvedValue(null);
      if (action === "new prompt") {
        expect(await ui.agent().submit("replacement")).toBe(true);
        await ui.until(() => ui.calls.length === 2 && !ui.agent().isLoading);
      } else invalidate(ui, action);
      await vi.advanceTimersByTimeAsync(201);
      await ui.until(() => !ui.agent().isLoading);
      expect(ui.stream).toHaveBeenCalledTimes(action === "new prompt" ? 2 : 1);
      expect(userTexts(ui)).toEqual(action === "clearMessages" ? [] : action === "loadSession" ? ["other history"] : action === "new prompt" ? ["original", "replacement"] : ["original"]);
      expect(ui.agent().conversation.getMessages().some(message => message.sourceText?.startsWith("Do Step"))).toBe(false);
    } finally { await ui.stop(); }
  });

  it.each(["cancel", "clearMessages", "loadSession", "activateSession"])("ignores a late completion loadPlan after %s", async action => {
    const ui = await mount();
    const oldPlan = gate<Plan | null>();
    boundary.loadPlan.mockResolvedValueOnce(null).mockImplementationOnce(() => oldPlan.promise);
    try {
      expect(await ui.agent().submit("original")).toBe(true);
      await ui.until(() => boundary.loadPlan.mock.calls.length === 2 && !ui.agent().isLoading);
      invalidate(ui, action);
      await ui.until(() => action !== "loadSession" && action !== "activateSession" || boundary.loadPlan.mock.calls.length === 3);
      oldPlan.resolve(pendingPlan());
      await ui.until(() => ui.agent().activePlan === null);
      await vi.advanceTimersByTimeAsync(300);
      expect(ui.timeout.mock.calls.filter(call => call[1] === 100)).toEqual([]);
      expect(ui.stream).toHaveBeenCalledTimes(1);
      expect(userTexts(ui)).toEqual(action === "clearMessages" ? [] : action === "loadSession" ? ["other history"] : ["original"]);
      expect(ui.agent().activePlan).toBeNull();
    } finally { oldPlan.resolve(null); await ui.stop(); }
  });

  it("reserves intervention ownership even after old iterator cleanup and before the 10ms handoff poll", async () => {
    const ui = await mount();
    ui.hold();
    try {
      expect(await ui.agent().submit("original")).toBe(true);
      await ui.until(() => ui.calls.length === 1);
      ui.agent().togglePause();
      await ui.until(() => ui.agent().isGenerationPaused);
      const intervention = ui.agent().interveneWhilePaused("intervention");
      expect(ui.calls[0]!.params.signal?.aborted).toBe(true);
      expect(await ui.agent().interveneWhilePaused("second intervention")).toBe(false);
      expect(await ui.agent().submit("competitor before cleanup")).toBe(false);
      ui.calls[0]!.finish();
      await ui.until(() => !ui.agent().isLoading);
      // submitPending has been released, but interventionPending must still own the handoff.
      expect(await ui.agent().submit("competitor after cleanup")).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect(await intervention).toBe(true);
      await ui.until(() => ui.calls.length === 2);
      expect(userTexts(ui)).toEqual(["original", "intervention"]);
      expect(ui.calls[1]!.params.messages.at(-1)?.sourceText).toBe("intervention");
      ui.calls[1]!.finish();
      await ui.until(() => !ui.agent().isLoading);
      expect(await ui.agent().submit("later prompt")).toBe(true);
      await ui.until(() => ui.calls.length === 3);
    } finally { await ui.stop(); }
  });
});
