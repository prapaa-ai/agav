import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";

const boundary = vi.hoisted(() => ({
  provider: null as LLMProvider | null,
  agent: undefined as ReturnType<typeof import("../hooks/use-agent.js").useAgent> | undefined,
  prompt: undefined as any,
  preparation: null as Promise<void> | null,
}));
// Observe the real hook; neither submit, intervention, cancellation nor the loop is replaced.
vi.mock("../hooks/use-agent.js", async importOriginal => {
  const original = await importOriginal<typeof import("../hooks/use-agent.js")>();
  return { ...original, useAgent: (...args: Parameters<typeof original.useAgent>) => {
    boundary.agent = original.useAgent(...args);
    return boundary.agent;
  } };
});
vi.mock("../providers/registry.js", () => ({ createProvider: () => boundary.provider }));
vi.mock("../components/input-prompt.js", () => ({ default: (props: any) => { boundary.prompt = props; return null; } }));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../config/history.js", () => ({ saveSession: vi.fn(async () => "session") }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(async () => {}), loadPlan: async () => null, clearPlan: vi.fn(async () => {}), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));
vi.mock("../utils/file-mentions.js", () => ({ expandFileMentions: async (text: string) => {
  if (boundary.preparation) await boundary.preparation;
  return { expanded: text, displayText: text, contentBlocks: [], warnings: [] };
} }));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function mount() {
  const calls: { text: string; params: StreamParams; finish: () => void; aborted: boolean }[] = [];
  const sideQueries: string[] = [];
  boundary.provider = { name: "mock", stream: async function* (params) {
    const text = params.messages.at(-1)!.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (text.startsWith("[SIDE QUESTION")) {
      sideQueries.push(text);
      yield { type: "text_delta", text: "side answer" };
      return;
    }
    const completion = gate();
    const call = { text, params, finish: completion.release, aborted: false };
    calls.push(call);
    // Deliberately hold iterator cleanup after abort to exercise the real handoff wait.
    params.signal?.addEventListener("abort", () => { call.aborted = true; }, { once: true });
    await completion.promise;
    if (!params.signal?.aborted) yield { type: "text_delta", text: `answer ${calls.length}` };
  } };
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 24, write: (text: string) => { chunks.push(text); return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 1, permissionMode: "auto-accept" };
  const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(boundary.prompt).toBeDefined());
  const output = () => chunks.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const stop = async () => {
    boundary.agent?.cancel();
    calls.forEach(call => call.finish());
    await vi.waitFor(() => expect(boundary.agent?.isLoading).toBe(false));
    instance.unmount();
  };
  return { instance, stdin, calls, sideQueries, output, stop };
}

async function startPaused(ui: Awaited<ReturnType<typeof mount>>) {
  await boundary.prompt.onSubmit("original");
  await vi.waitFor(() => expect(ui.calls).toHaveLength(1));
  boundary.agent!.togglePause();
  await vi.waitFor(() => expect(boundary.agent!.isGenerationPaused).toBe(true));
}

describe("App request handoff with real useAgent and agent loop", () => {
  beforeEach(() => { boundary.preparation = null; boundary.prompt = undefined; });

  it("owns paused intervention through aborted iterator cleanup, queues later prompts FIFO, and keeps /ps immediate", async () => {
    const ui = await mount();
    try {
      await startPaused(ui);
      boundary.prompt.onChange("intervention");
      await vi.waitFor(() => expect(boundary.prompt.value).toBe("intervention"));
      const pending = boundary.prompt.onSubmit("intervention");
      await vi.waitFor(() => expect(ui.calls[0]!.aborted).toBe(true));
      await boundary.prompt.onSubmit("second");
      await boundary.prompt.onSubmit("third");
      await boundary.prompt.onSubmit("/ps status?");
      await vi.waitFor(() => expect(ui.sideQueries).toHaveLength(1));
      await vi.waitFor(() => expect(ui.output()).toContain("Queued 2"));
      expect(ui.calls).toHaveLength(1);
      ui.calls[0]!.finish();
      await pending;
      await vi.waitFor(() => expect(ui.calls).toHaveLength(2));
      expect(ui.calls[1]!.text).toBe("intervention");
      expect(boundary.agent!.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["original", "intervention"]);
      ui.calls[1]!.finish();
      await vi.waitFor(() => expect(ui.calls).toHaveLength(3));
      expect(ui.calls[2]!.text).toBe("second");
      ui.calls[2]!.finish();
      await vi.waitFor(() => expect(ui.calls).toHaveLength(4));
      expect(ui.calls[3]!.text).toBe("third");
    } finally { await ui.stop(); }
  });

  it("retains the intervention composer when cancelled during handoff", async () => {
    const ui = await mount();
    try {
      await startPaused(ui);
      boundary.prompt.onPaste("intervention attachment".repeat(6), (label: string) => boundary.prompt.onChange(label));
      await vi.waitFor(() => expect(boundary.prompt.value).toContain("Pasted"));
      const draft = boundary.prompt.value;
      const pending = boundary.prompt.onSubmit(draft);
      await vi.waitFor(() => expect(ui.calls[0]!.aborted).toBe(true));
      ui.stdin.emit("data", Buffer.from("\x03"));
      await new Promise(resolve => setTimeout(resolve, 60));
      ui.calls[0]!.finish();
      await pending;
      await vi.waitFor(() => expect(boundary.agent!.isLoading).toBe(false));
      expect(ui.calls).toHaveLength(1);
      expect(boundary.prompt.value).toBe(draft);
      await boundary.prompt.onSubmit(draft);
      await vi.waitFor(() => expect(ui.calls).toHaveLength(2));
      expect(ui.calls[1]!.params.messages.at(-1)!.content).toContainEqual(expect.objectContaining({ text: "intervention attachment".repeat(6) }));
    } finally { await ui.stop(); }
  });

  it("keeps text and attachments edited synchronously during real slow preparation", async () => {
    const ui = await mount();
    const preparation = gate();
    try {
      boundary.prompt.onPaste("submitted paste".repeat(8), (label: string) => boundary.prompt.onChange(label));
      await vi.waitFor(() => expect(boundary.prompt.value).toContain("Pasted"));
      boundary.preparation = preparation.promise;
      const pending = boundary.prompt.onSubmit(boundary.prompt.value);
      await new Promise(resolve => setTimeout(resolve, 60));
      boundary.prompt.onPaste("new paste".repeat(8), () => {});
      boundary.prompt.onChange("new draft");
      preparation.release();
      await pending;
      await vi.waitFor(() => expect(ui.calls).toHaveLength(1));
      expect(boundary.prompt.value).toBe("new draft");
      expect(ui.calls[0]!.params.messages.at(-1)!.content).toContainEqual(expect.objectContaining({ text: "submitted paste".repeat(8) }));
      expect(ui.calls[0]!.params.messages.at(-1)!.content).not.toContainEqual(expect.objectContaining({ text: "new paste".repeat(8) }));
      ui.calls[0]!.finish();
      await vi.waitFor(() => expect(boundary.agent!.isLoading).toBe(false));
      boundary.preparation = null;
      await boundary.prompt.onSubmit("new draft");
      await vi.waitFor(() => expect(ui.calls).toHaveLength(2));
      expect(ui.calls[1]!.params.messages.at(-1)!.content.filter(block => block.type === "text")).toEqual([
        expect.objectContaining({ text: "new draft" }), expect.objectContaining({ text: "new paste".repeat(8) }),
      ]);
    } finally { preparation.release(); boundary.preparation = null; await ui.stop(); }
  });

  it.each(["\x1b", "\x03"])("aborts preparation with %j and retains the draft", async key => {
    const ui = await mount();
    const preparation = gate();
    try {
      boundary.preparation = preparation.promise;
      boundary.prompt.onChange("preparing");
      await vi.waitFor(() => expect(boundary.prompt.value).toBe("preparing"));
      const pending = boundary.prompt.onSubmit("preparing");
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(boundary.agent!.isLoading).toBe(true);
      ui.stdin.emit("data", Buffer.from(key));
      await new Promise(resolve => setTimeout(resolve, 60));
      preparation.release();
      await pending;
      expect(ui.calls).toHaveLength(0);
      expect(boundary.prompt.value).toBe("preparing");
      expect(boundary.agent!.messages.filter(message => message.role === "user")).toEqual([]);
    } finally { preparation.release(); boundary.preparation = null; await ui.stop(); }
  });
});
