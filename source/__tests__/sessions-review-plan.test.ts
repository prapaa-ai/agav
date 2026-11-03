import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";

// Keep history, runtime storage and attachment polling real.
const originalCwd = process.cwd();
let root: string;
vi.mock("../config/config.js", async importOriginal => ({
  ...await importOriginal<typeof import("../config/config.js")>(),
  getAgavDir: () => root, loadConfig: async () => config,
}));
// Isolate extension/context boundaries in the same way as session-name.test.ts.
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: vi.fn(async () => []) }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../skills/improvement.js", () => ({ maybeRunBackgroundImprovement: async () => {} }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: vi.fn(async () => ""), refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));

// Supervisor observation is offline; durable session storage and approval decisions remain real.
vi.mock("../background-jobs-integration.js", () => ({
  getSharedCoordinator: async () => ({ poll: vi.fn(async () => undefined), findByRequestId: async () => undefined, start: admission.start }),
}));

import { startInteractiveSessionWorker } from "../sessions/interactive.js";
import { loadPlugins } from "../plugins/loader.js";
import { refreshStableContext } from "../utils/system-prompt.js";
import { getPlanScope, loadPlan, savePlan, setPlanScope } from "../agent/planner.js";
const admission = vi.hoisted(() => ({ start: vi.fn() }));
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
  vi.mocked(loadPlugins).mockClear();
  process.chdir(root);
  setPlanScope(null);
  admission.start.mockReset();
});
afterEach(async () => {
  for (const instance of mounts.splice(0)) instance.unmount();
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  setPlanScope(null);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

async function mount(overrides: Partial<AgavConfig> = {}) {
  const stream = vi.fn<LLMProvider["stream"]>(async function* () { yield { type: "text_delta", text: JSON.stringify({ goal: "Prepared draft", steps: [{ id: 1, title: "Implement", description: "Implement feature" }] }) }; });
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
  await until(() => vi.mocked(loadPlugins).mock.calls.length > 0, flush);
  return { agent: () => agent, stream, until: (predicate: () => boolean | Promise<boolean>) => until(predicate, flush),
    unmount: () => { instance.unmount(); mounts.splice(mounts.indexOf(instance), 1); } };
}

describe("prepared first-turn plan handoff", () => {
  it("loads and updates the real prepared plan under the session scope before worker admission", async () => {
    let admitted = false;
    admission.start.mockImplementation(async (request: import("../background-jobs/types.js").StartJobRequest) => {
      const records = await store.list();
      const record = records[0]!;
      expect(getPlanScope()).toBe(record.id);
      setPlanScope(record.id); // same scope selected by a fresh worker
      const plan = await loadPlan();
      expect(plan?.goal).toBe("Prepared draft");
      expect(plan?.steps[0]?.status).toBe("pending");
      plan!.steps[0]!.status = "in_progress";
      await savePlan(plan!);
      admitted = true;
      return { requestId: request.requestId, jobId: "plan-worker", state: "running", stopState: "none" };
    });
    const ui = await mount();
    expect(await ui.agent().submit("plan: implement a feature")).toBe(true);
    await ui.until(() => admitted || ui.agent().messages.some(message => message.isError));
    expect(admitted, JSON.stringify(ui.agent().messages)).toBe(true);
    expect((await loadPlan())?.steps[0]?.status).toBe("in_progress");
    expect(ui.stream).toHaveBeenCalledOnce(); // planning only, never foreground execution
  });

  it("awaits an asynchronous onCreated handoff before coordinator admission", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let created = false;
    admission.start.mockImplementation(async request => ({ requestId: request.requestId, jobId: "async-worker", state: "running", stopState: "none" }));
    const pending = startInteractiveSessionWorker(config, new (await import("../agent/conversation.js")).ConversationState(), {
      permissionMode: "ask", iterationsBudget: { remaining: 4, total: 4 }, signal: new AbortController().signal,
      onCreated: async () => { created = true; await ready; },
    });
    try {
      await until(() => created);
      await sleep(50);
      expect(admission.start).not.toHaveBeenCalled();
    } finally { release(); }
    await expect(pending).resolves.toMatchObject({ status: "starting" });
  });
});
