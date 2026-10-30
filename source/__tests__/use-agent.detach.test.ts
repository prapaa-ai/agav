import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";

// Keep history, runtime storage, attachment polling and the approval broker real.
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
import { shouldAutoPlan } from "../agent/planner.js";
import { useAgent } from "../hooks/use-agent.js";
import render from "../ink/render.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { SessionApprovalBroker, decideSessionApproval, listPendingApprovals } from "../sessions/approvals.js";

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000,
  maxIterations: 4, errorRetries: 1, permissionMode: "ask", backgroundJobsEnabled: true, detachedSessionsEnabled: true };
const request = { toolName: "write_file", input: { path: "example.txt", content: "hello" } };
let store: SessionRuntimeStore;
const brokers: SessionApprovalBroker[] = [];
const waiting: Promise<unknown>[] = [];
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
    return store.update(record.id, record.generation, current => {
      current.jobId = "durable-worker-job";
      current.status = "running";
    });
  });
});
afterEach(async () => {
  for (const instance of mounts.splice(0)) instance.unmount();
  for (const broker of brokers.splice(0)) broker.clear();
  await Promise.all(waiting.splice(0));
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

describe("useAgent worker-first detach", () => {
  it.each(["yes", "no"] as const)("launches before local inference and preserves worker consent through detach/unmount (%s)", async choice => {
    const subscribe = vi.spyOn(client, "subscribeSession");
    const ui = await mount();
    expect(ui.agent().canDetach).toBe(false);
    expect(await ui.agent().submit("Write a short greeting to example.txt")).toBe(true);
    await ui.until(() => ui.agent().canDetach);
    expect(shouldAutoPlan).toHaveBeenCalled();
    expect(startInteractiveSessionWorker).toHaveBeenCalledOnce();
    expect(ui.stream).not.toHaveBeenCalled();
    const record = await vi.mocked(startInteractiveSessionWorker).mock.results[0]!.value;
    expect(record.jobId).toBe("durable-worker-job");
    expect(await store.read(record.id)).toEqual(record);
    expect(record.messages).toContainEqual(expect.objectContaining({ role: "user",
      content: expect.arrayContaining([{ type: "text", text: "Write a short greeting to example.txt" }]) }));
    expect(ui.agent().sessionId).toBe(record.id);
    expect(subscribe).toHaveBeenCalledWith(record.id, expect.any(Object));

    const broker = new SessionApprovalBroker(store, record.id, record.generation, { pollMs: 10 });
    brokers.push(broker);
    let settled = false;
    const decision = broker.confirm(request).then(result => { settled = true; return result; });
    waiting.push(decision);
    await ui.until(() => !!ui.agent().pendingConfirmation);
    const prompt = ui.agent().pendingConfirmation!;
    expect(prompt.sessionApproval).toMatchObject({ sessionId: record.id, generation: record.generation });
    const pending = await listPendingApprovals(store, record.id);

    expect(await ui.agent().detachSession()).toBe(record.id);
    expect(await ui.agent().detachSession()).toBe(record.id);
    expect(ui.agent().pendingConfirmation).toBe(prompt);
    expect(ui.agent().isLoading).toBe(true);
    expect(settled).toBe(false);
    expect(await listPendingApprovals(store, record.id)).toEqual(pending);
    expect(startInteractiveSessionWorker).toHaveBeenCalledOnce();
    expect(ui.stream).not.toHaveBeenCalled();

    ui.unmount();
    // Cross a real polling interval so an unmount cleanup cannot silently deny consent.
    await sleep(300);
    expect(settled).toBe(false);
    expect(await listPendingApprovals(store, record.id)).toEqual(pending);
    expect(await store.read(record.id)).toMatchObject({ jobId: record.jobId, status: "needs-approval" });
    await decideSessionApproval(store, record.id, pending[0]!.approvalId, choice);
    await until(() => settled);
    expect(await decision).toBe(choice);
    expect(await listPendingApprovals(store, record.id)).toEqual([]);
    expect(startInteractiveSessionWorker).toHaveBeenCalledOnce();
    expect(ui.stream).not.toHaveBeenCalled();
  });

  it("retains ownership after onCreated even when the launch response is lost", async () => {
    const subscribe = vi.spyOn(client, "subscribeSession");
    vi.mocked(startInteractiveSessionWorker).mockImplementationOnce(async (workerConfig, conversation, options) => {
      const record = await createSessionExecution(store, workerConfig, { conversation, ...options });
      options.onCreated?.(record);
      throw new Error("lost response");
    });
    const ui = await mount();
    expect(await ui.agent().submit("Keep the worker-owned turn")).toBe(true);
    await ui.until(() => !!ui.agent().sessionId && subscribe.mock.calls.length === 1);
    await expect(vi.mocked(startInteractiveSessionWorker).mock.results[0]!.value).rejects.toThrow("lost response");
    const id = ui.agent().sessionId!;
    expect(id).toBeTruthy();
    expect(subscribe).toHaveBeenCalledWith(id, expect.any(Object));
    expect(await store.read(id)).toMatchObject({ id, status: "starting" });
    // The launch has rejected and local loading was cleared; the live attachment still owns the turn.
    expect(ui.agent().isLoading).toBe(true);
    expect(await ui.agent().submit("Competing prompt")).toBe(false);
    expect(startInteractiveSessionWorker).toHaveBeenCalledOnce();
    expect(ui.stream).not.toHaveBeenCalled();
    ui.agent().clearMessages();
    await ui.until(() => !ui.agent().isLoading);
    expect(await store.read(id)).toMatchObject({ id, status: "starting" });
  });

  it.each(["clearMessages", "loadSession"] as const)("does not reselect a stale launch after %s", async action => {
    const subscribe = vi.spyOn(client, "subscribeSession");
    let release!: () => void;
    const admission = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(startInteractiveSessionWorker).mockImplementationOnce(async (workerConfig, conversation, options) => {
      const record = await createSessionExecution(store, workerConfig, { conversation, ...options });
      options.onCreated?.(record);
      await admission;
      return store.update(record.id, record.generation, current => {
        current.jobId = "durable-worker-job";
        current.status = "running";
      });
    });
    const ui = await mount();
    try {
      expect(await ui.agent().submit("Start a worker before switching sessions")).toBe(true);
      await ui.until(() => !!ui.agent().sessionId && subscribe.mock.calls.length === 1);
      const id = ui.agent().sessionId!;
      expect(await store.read(id)).toMatchObject({ id, status: "starting" });
      expect(ui.agent().isLoading).toBe(true);
      if (action === "clearMessages") ui.agent().clearMessages();
      else ui.agent().loadSession({ id: "selected-session", createdAt: "2026-01-01", model: "mock",
        provider: "anthropic", title: "Selected session", messages: [
          { role: "user", content: [{ type: "text", text: "selected history" }] },
        ] });
      const selectedId = action === "clearMessages" ? undefined : "selected-session";
      await ui.until(() => ui.agent().sessionId === selectedId);
      release();
      const record = await vi.mocked(startInteractiveSessionWorker).mock.results[0]!.value;
      // Cross a real subscription interval to expose a stale reattachment or transcript update.
      await sleep(300);
      await ui.until(() => ui.agent().sessionId === selectedId);
      expect(ui.agent().messages.map(message => message.content)).toEqual(action === "clearMessages" ? [] : ["selected history"]);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(await store.read(id)).toEqual(record);
      expect(record).toMatchObject({ id, jobId: "durable-worker-job", status: "running" });
      expect(startInteractiveSessionWorker).toHaveBeenCalledOnce();
      expect(ui.stream).not.toHaveBeenCalled();
    } finally {
      release();
      await vi.mocked(startInteractiveSessionWorker).mock.results[0]?.value;
    }
  });

  it("background jobs alone do not opt ordinary prompts into worker execution", async () => {
    const ui = await mount({ detachedSessionsEnabled: false });
    expect(await ui.agent().submit("Say hello")).toBe(true);
    await ui.until(() => ui.stream.mock.calls.length === 1 && !ui.agent().isLoading);
    expect(startInteractiveSessionWorker).not.toHaveBeenCalled();
  });

  it("releases failed pre-admission ownership and permits a follow-up task", async () => {
    vi.mocked(startInteractiveSessionWorker).mockImplementationOnce(async (workerConfig, conversation, options) => {
      const record = await createSessionExecution(store, workerConfig, { conversation, ...options });
      options.onCreated?.(record);
      const failed = await store.update(record.id, record.generation, current => { current.status = "failed"; });
      throw Object.assign(new Error("coordinator unavailable before admission"), { admission: "not-admitted", record: failed });
    });
    const ui = await mount();
    expect(await ui.agent().submit("First attempt")).toBe(true);
    await ui.until(() => !ui.agent().isLoading && ui.agent().messages.some(message => message.content.includes("coordinator unavailable")));
    expect(ui.agent().canDetach).toBe(false);
    const id = ui.agent().sessionId;
    expect(await ui.agent().submit("Retry after launch failure")).toBe(true);
    await ui.until(() => ui.agent().canDetach);
    expect(ui.agent().sessionId).toBe(id);
    expect(startInteractiveSessionWorker).toHaveBeenCalledTimes(2);
    expect(ui.stream).not.toHaveBeenCalled();
  });

  it("cancel publishes durable cancellation for the selected worker generation", async () => {
    const ui = await mount();
    expect(await ui.agent().submit("Run task")).toBe(true);
    await ui.until(() => ui.agent().canDetach);
    const id = ui.agent().sessionId!;
    await ui.agent().cancel();
    expect((await store.read(id))!.cancelRequested).toBe(true);
    expect(ui.agent().isLoading).toBe(true); // Ownership remains until the worker acknowledges.
  });

  it("rejects detach when background jobs are disabled and executes the normal prompt locally", async () => {
    const ui = await mount({ backgroundJobsEnabled: false });
    expect(await ui.agent().submit("Say hello")).toBe(true);
    await ui.until(() => ui.stream.mock.calls.length === 1 && !ui.agent().isLoading);
    expect(ui.agent().messages.some(message => message.content === "local response")).toBe(true);
    expect(ui.agent().canDetach).toBe(false);
    await expect(ui.agent().detachSession()).rejects.toThrow("Enable detachedSessionsEnabled");
    expect(startInteractiveSessionWorker).not.toHaveBeenCalled();
  });

  it("cannot detach while turn preparation has not yet handed ownership to the worker", async () => {
    let release!: (value: string) => void;
    vi.mocked(refreshStableContext).mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const ui = await mount();
    try {
      expect(await ui.agent().submit("Prepare a greeting")).toBe(true);
      await ui.until(() => !!release && ui.agent().isLoading);
      expect(ui.agent().canDetach).toBe(false);
      await expect(ui.agent().detachSession()).rejects.toThrow("Wait for preparation to finish");
      expect(startInteractiveSessionWorker).not.toHaveBeenCalled();
      expect(ui.stream).not.toHaveBeenCalled();
    } finally {
      release?.("");
    }
    await ui.until(() => ui.agent().canDetach);
    expect(startInteractiveSessionWorker).toHaveBeenCalledOnce();
    const record = await vi.mocked(startInteractiveSessionWorker).mock.results[0]!.value;
    expect(await ui.agent().detachSession()).toBe(record.id);
    expect(ui.stream).not.toHaveBeenCalled();
  });
});
