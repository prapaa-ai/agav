import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";

// Keep history, runtime storage and attachment polling real.
let root: string;
vi.mock("../config/config.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/config.js")>(),
  getAgavDir: () => root,
}));
// Isolate extension/context boundaries in the same way as session-name.test.ts.
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../skills/improvement.js", () => ({ maybeRunBackgroundImprovement: async () => {} }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: vi.fn(async () => ""), refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({
  shouldAutoPlan: vi.fn(() => false), savePlan: vi.fn(async () => {}), loadPlan: async () => null,
  clearPlan: vi.fn(async () => {}), isPlanActive: () => false, setPlanScope: vi.fn(),
  adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {},
}));

vi.mock("../sessions/interactive.js", () => ({ startInteractiveSessionWorker: vi.fn() }));
// Supervisor observation is offline; durable session storage and approval decisions remain real.
vi.mock("../background-jobs-integration.js", () => ({
  getSharedCoordinator: async () => ({ poll: vi.fn(async () => undefined) }),
}));

import { startInteractiveSessionWorker } from "../sessions/interactive.js";
import { createSessionExecution } from "../sessions/runner.js";
import * as client from "../sessions/client.js";
import { refreshStableContext } from "../utils/system-prompt.js";
import { useAgent } from "../hooks/use-agent.js";
import render from "../ink/render.js";
import { SessionRuntimeStore } from "../sessions/store.js";

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000,
  maxIterations: 4, errorRetries: 1, permissionMode: "ask", backgroundJobsEnabled: true };
let store: SessionRuntimeStore;
const mounts: ReturnType<typeof render>[] = [];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Real timers let Ink's scheduler and the actual disk-polling subscription cooperate.
async function until(predicate: () => boolean | Promise<boolean>, flush: () => Promise<void> = async () => {}) {
  const deadline = Date.now() + 2000;
  do {
    await flush();
    if (await predicate()) return;
    await sleep(10);
  } while (Date.now() < deadline);
  throw new Error("Session attachment did not reach the expected state within 2 seconds");
}

beforeEach(async () => {
  vi.useRealTimers();
  root = await mkdtemp(join(tmpdir(), "agav-use-agent-detach-"));
  store = new SessionRuntimeStore();
  vi.mocked(refreshStableContext).mockResolvedValue("");
  vi.mocked(startInteractiveSessionWorker).mockReset().mockImplementation(async (workerConfig, conversation, options) => {
    const record = await createSessionExecution(store, workerConfig, { conversation, ...options });
    await options.onCreated?.(record);
    return store.update(record.id, record.generation, current => {
      current.jobId = "durable-worker-job";
      current.status = "running";
    });
  });
});
afterEach(async () => {
  for (const instance of mounts.splice(0)) instance.unmount();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

async function mount(overrides: Partial<AgavConfig> = {}) {
  const stream = vi.fn<LLMProvider["stream"]>(async function* () { yield { type: "text_delta", text: "local response" }; });
  const provider: LLMProvider = { name: "mock", stream };
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  let agent!: ReturnType<typeof useAgent>;
  function App() {
    agent = useAgent(provider, { ...config, ...overrides });
    return null;
  }
  const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  mounts.push(instance);
  const flush = () => instance.waitUntilRenderFlush();
  await flush();
  return { agent: () => agent, stream, until: (predicate: () => boolean | Promise<boolean>) => until(predicate, flush),
    unmount: () => { instance.unmount(); mounts.splice(mounts.indexOf(instance), 1); } };
}

describe("useAgent review launch boundaries", () => {
  it("releases the cancelled launch latch after onCreated and a delayed successful response", async () => {
    let release!: () => void;
    const admission = new Promise<void>(resolve => { release = resolve; });
    let created!: import("../sessions/store.js").SessionRuntimeRecord;
    vi.mocked(startInteractiveSessionWorker).mockImplementationOnce(async (workerConfig, conversation, options) => {
      created = await createSessionExecution(store, workerConfig, { conversation, ...options });
      await options.onCreated?.(created);
      await admission;
      return created;
    });
    const ui = await mount();
    try {
      expect(await ui.agent().submit("Start work")).toBe(true);
      await ui.until(() => !!ui.agent().sessionId);
      await ui.agent().cancel();
      expect((await store.read(created.id))?.cancelRequested).toBe(true);
      release();
      await vi.mocked(startInteractiveSessionWorker).mock.results[0]!.value;
      await store.update(created.id, created.generation, record => { record.status = "cancelled"; });
      await ui.until(() => !ui.agent().isLoading);
      expect(await ui.agent().submit("Follow up after cancellation")).toBe(true);
      await ui.until(() => vi.mocked(startInteractiveSessionWorker).mock.calls.length === 2);
      expect(ui.stream).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it("ignores a stale response without reattaching or cancelling the selected generation", async () => {
    let release!: () => void;
    const admission = new Promise<void>(resolve => { release = resolve; });
    let created!: import("../sessions/store.js").SessionRuntimeRecord;
    vi.mocked(startInteractiveSessionWorker).mockImplementationOnce(async (workerConfig, conversation, options) => {
      created = await createSessionExecution(store, workerConfig, { conversation, ...options });
      await options.onCreated?.(created);
      await admission;
      return created;
    });
    const subscribe = vi.spyOn(client, "subscribeSession");
    const ui = await mount();
    try {
      expect(await ui.agent().submit("Old work")).toBe(true);
      await ui.until(() => !!ui.agent().sessionId);
      ui.agent().clearMessages();
      release();
      await vi.mocked(startInteractiveSessionWorker).mock.results[0]!.value;
      await ui.until(() => !ui.agent().isLoading);
      expect(ui.agent().sessionId).toBeUndefined();
      expect(ui.agent().messages).toEqual([]);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect((await store.read(created.id))?.cancelRequested).toBeUndefined();
      expect(await ui.agent().submit("New work")).toBe(true);
      await ui.until(() => vi.mocked(startInteractiveSessionWorker).mock.calls.length === 2);
    } finally { release(); }
  });

  it("rejects foreground pause and intervention without cancelling a live worker", async () => {
    const ui = await mount();
    expect(await ui.agent().submit("Worker task")).toBe(true);
    await ui.until(() => ui.agent().canDetach);
    const id = ui.agent().sessionId!;
    ui.agent().togglePause();
    await sleep(30);
    await ui.until(() => true);
    expect(ui.agent().isGenerationPaused).toBe(false);
    expect(await ui.agent().interveneWhilePaused("Do something else")).toBe(false);
    expect((await store.read(id))?.cancelRequested).toBeUndefined();
    expect(startInteractiveSessionWorker).toHaveBeenCalledOnce();
    expect(ui.stream).not.toHaveBeenCalled();
    expect(ui.agent().isLoading).toBe(true);
  });
});
