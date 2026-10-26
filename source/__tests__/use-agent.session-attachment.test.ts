import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { SessionRecord } from "../config/history.js";
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
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({
  shouldAutoPlan: () => false, savePlan: vi.fn(async () => {}), loadPlan: async () => null,
  clearPlan: vi.fn(async () => {}), isPlanActive: () => false, setPlanScope: vi.fn(),
  adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {},
}));

import { useAgent } from "../hooks/use-agent.js";
import render from "../ink/render.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { SessionApprovalBroker, decideSessionApproval, listPendingApprovals } from "../sessions/approvals.js";
import { loadResumableSession } from "../sessions/history.js";
import * as targeting from "../agents/targeting.js";

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000,
  maxIterations: 4, errorRetries: 1, permissionMode: "ask" };
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
  root = await mkdtemp(join(tmpdir(), "agav-use-agent-attachment-"));
  store = new SessionRuntimeStore();
});
afterEach(async () => {
  for (const instance of mounts.splice(0)) instance.unmount();
  for (const broker of brokers.splice(0)) broker.clear();
  await Promise.all(waiting.splice(0));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function runtime() {
  const record = await store.create({ cwd: root, provider: "anthropic", model: "mock", permissionMode: "ask",
    sandboxRequired: false, messages: [{ role: "user", content: [{ type: "text", text: "worker history" }] }] });
  const broker = new SessionApprovalBroker(store, record.id, record.generation, { pollMs: 10 });
  brokers.push(broker);
  function confirm() {
    let settled = false;
    const promise = broker.confirm(request).then(result => { settled = true; return result; });
    waiting.push(promise);
    return { promise, settled: () => settled };
  }
  const first = confirm();
  // Publication precedes status reconciliation inside the broker's lock.
  await until(async () => store.lock(record.id, async () =>
    (await store.read(record.id))?.status === "needs-approval" &&
    (await listPendingApprovals(store, record.id)).length === 1));
  const session = await loadResumableSession(record.id);
  expect(session?.runtime).toMatchObject({ generation: record.generation, status: "needs-approval", pendingCount: 1 });
  return { record, session: session!, first, confirm };
}

async function mount(initial?: SessionRecord) {
  const stream = vi.fn<LLMProvider["stream"]>(async function* () { yield { type: "text_delta", text: "unexpected local execution" }; });
  const provider: LLMProvider = { name: "mock", stream };
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  let agent!: ReturnType<typeof useAgent>;
  function App() {
    // These are the positional resume arguments passed by the CLI/App startup path.
    agent = useAgent(provider, config, initial?.messages, initial?.id, initial?.tokenUsage,
      initial?.compacted, initial?.name, initial?.runtime);
    return null;
  }
  const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  mounts.push(instance);
  const flush = () => instance.waitUntilRenderFlush();
  await flush();
  return { agent: () => agent, stream, until: (predicate: () => boolean | Promise<boolean>) => until(predicate, flush),
    unmount: () => { instance.unmount(); mounts.splice(mounts.indexOf(instance), 1); } };
}

describe("useAgent durable session attachment", () => {
  for (const entry of ["loadSession", "CLI resumeRuntime"] as const) {
    it.each(["yes", "no"] as const)(`${entry} displays durable consent and forwards %s to the waiting worker`, async choice => {
      const worker = await runtime();
      const ui = await mount(entry === "CLI resumeRuntime" ? worker.session : undefined);
      if (entry === "loadSession") ui.agent().loadSession(worker.session);
      await ui.until(() => !!ui.agent().pendingConfirmation);
      const prompt = ui.agent().pendingConfirmation!;
      expect(prompt).toMatchObject({ ...request, sessionApproval: { sessionId: worker.record.id, generation: worker.record.generation } });
      expect(ui.agent().sessionId).toBe(worker.record.id);
      expect(ui.agent().messages.map(message => message.content)).toContain("worker history");
      expect(ui.agent().isLoading).toBe(true);
      expect(await ui.agent().submit("must not start a competing local turn")).toBe(false);
      expect(ui.stream).not.toHaveBeenCalled();
      ui.agent().confirmTool(choice, prompt);
      await ui.until(worker.first.settled);
      expect(await worker.first.promise).toBe(choice);
      await ui.until(() => ui.agent().pendingConfirmation === null);
      expect(await listPendingApprovals(store, worker.record.id)).toEqual([]);
      expect(ui.stream).not.toHaveBeenCalled();
    });
  }

  it("persists an attached runtime rename without overwriting its live transcript or approvals", async () => {
    const worker = await runtime();
    const ui = await mount(worker.session);
    await ui.until(() => !!ui.agent().pendingConfirmation);
    const prompt = ui.agent().pendingConfirmation!;
    const before = await store.read(worker.record.id);
    ui.agent().renameSession("Renamed background work");
    await ui.until(async () => (await loadResumableSession(worker.record.id))?.title === "Renamed background work");
    expect((await store.read(worker.record.id))?.messages).toEqual(before!.messages);
    expect(ui.agent().pendingConfirmation).toBe(prompt);
    expect(worker.first.settled()).toBe(false);
    ui.agent().confirmTool("no", prompt);
    await ui.until(worker.first.settled);
  });

  it("cancel keeps live loading and approval ownership, blocking local execution without denying worker consent", async () => {
    const worker = await runtime();
    const ui = await mount(worker.session);
    await ui.until(() => !!ui.agent().pendingConfirmation);
    const prompt = ui.agent().pendingConfirmation!;
    const pending = await listPendingApprovals(store, worker.record.id);
    const before = await store.read(worker.record.id);

    ui.agent().cancel();
    // Force another real snapshot so this does not only assert the pre-cancel render.
    await store.update(worker.record.id, worker.record.generation, record => {
      record.messages.push({ role: "assistant", content: [{ type: "text", text: "worker still running" }] });
    });
    await ui.until(() => ui.agent().messages.some(message => message.content === "worker still running"));
    expect(ui.agent().isLoading).toBe(true);
    expect(ui.agent().pendingConfirmation).toBe(prompt);
    expect(ui.agent().sessionId).toBe(worker.record.id);
    expect(await ui.agent().submit("must remain blocked after cancel")).toBe(false);
    expect(await ui.agent().submitToAgent("helper", "blocked query", "/helper blocked query")).toBe(false);
    expect(ui.stream).not.toHaveBeenCalled();
    expect(worker.first.settled()).toBe(false);
    expect(await listPendingApprovals(store, worker.record.id)).toEqual(pending);
    expect(await store.read(worker.record.id)).toMatchObject({
      generation: before!.generation, status: "needs-approval", permissionMode: "ask",
    });

    // The original displayed prompt still answers the actual worker after cancel.
    ui.agent().confirmTool("yes", prompt);
    await ui.until(worker.first.settled);
    expect(await worker.first.promise).toBe("yes");
  });

  it.each(["submit", "submitToAgent"] as const)("%s continues a completed worker in the same resumable session", async method => {
    const worker = await runtime();
    const ui = await mount(worker.session);
    await ui.until(() => !!ui.agent().pendingConfirmation);
    const prompt = ui.agent().pendingConfirmation!;
    // Resolve consent before setting terminal status: the broker reconciles status on settlement.
    ui.agent().confirmTool("yes", prompt);
    await ui.until(worker.first.settled);
    expect(await worker.first.promise).toBe("yes");
    await store.update(worker.record.id, worker.record.generation, record => {
      record.status = "completed";
      record.messages.push({ role: "assistant", content: [{ type: "text", text: "worker finished" }] });
    });
    await ui.until(() => !ui.agent().isLoading && ui.agent().pendingConfirmation === null &&
      ui.agent().messages.some(message => message.content === "worker finished"));
    const completed = await store.read(worker.record.id);
    expect(ui.agent().sessionId).toBe(worker.record.id);

    const continuation = "continue the finished work";
    const answer = "local continuation response";
    if (method === "submitToAgent") {
      vi.spyOn(targeting, "resolveTargetAgent").mockResolvedValue({ agent: {
        manifest: { name: "helper", description: "Test helper", version: "1" },
        systemPrompt: "", tools: [], origin: "project", path: root,
      } });
      vi.spyOn(targeting, "executeTargetedAgent").mockResolvedValue({ output: answer, isError: false, agentName: "helper" });
      expect(await ui.agent().submitToAgent("helper", continuation, continuation)).toBe(true);
    } else {
      ui.stream.mockImplementationOnce(async function* () { yield { type: "text_delta", text: answer }; });
      expect(await ui.agent().submit(continuation)).toBe(true);
    }
    await ui.until(() => !ui.agent().isLoading && !!ui.agent().sessionId && ui.agent().messages.some(message => message.content === answer));
    const newId = ui.agent().sessionId!;
    expect(newId).toBe(worker.record.id);
    expect(ui.agent().error).toBeNull();
    if (method === "submitToAgent") {
      expect(targeting.resolveTargetAgent).toHaveBeenCalledWith("helper");
      expect(targeting.executeTargetedAgent).toHaveBeenCalledOnce();
      expect(ui.stream).not.toHaveBeenCalled();
    } else {
      expect(ui.stream).toHaveBeenCalledOnce();
    }
    await ui.until(async () => {
      const saved = await loadResumableSession(newId);
      return !!saved?.messages.some(message => message.content.some(block => block.type === "text" && block.text === answer));
    });
    const resumed = await loadResumableSession(newId);
    expect(resumed!.runtime?.generation).toBe(completed!.generation);
    ui.unmount();
    const later = await mount(resumed!);
    expect(later.agent().sessionId).toBe(newId);
    await later.until(() => !later.agent().isLoading);
    expect(later.agent().messages.map(message => message.content)).toEqual([
      "worker history", "worker finished", continuation, answer,
    ]);
    expect((await store.read(worker.record.id))!.messages).toEqual(resumed!.messages);
  });

  it("keeps the displayed prompt identity stable across polls and rejects it after a successor appears", async () => {
    const worker = await runtime();
    const ui = await mount(worker.session);
    await ui.until(() => !!ui.agent().pendingConfirmation);
    const first = ui.agent().pendingConfirmation!;
    // Observe two new snapshots, rather than merely sleeping and assuming polling happened.
    for (const text of ["poll one", "poll two"]) {
      await store.update(worker.record.id, worker.record.generation, record => {
        record.messages.push({ role: "assistant", content: [{ type: "text", text }] });
      });
      await ui.until(() => ui.agent().messages.some(message => message.content === text));
      expect(ui.agent().pendingConfirmation).toBe(first);
      expect(ui.agent().pendingConfirmation!.sessionApproval).toBe(first.sessionApproval);
    }
    ui.agent().confirmTool("yes", first);
    await ui.until(worker.first.settled);
    expect(await worker.first.promise).toBe("yes");
    const successor = worker.confirm(); // Identical operation, but fresh consent identity.
    await ui.until(() => !!ui.agent().pendingConfirmation && ui.agent().pendingConfirmation !== first);
    const second = ui.agent().pendingConfirmation!;
    expect(second.sessionApproval!.approvalId).not.toBe(first.sessionApproval!.approvalId);
    ui.agent().confirmTool("yes", first);
    await sleep(300);
    expect(successor.settled()).toBe(false);
    expect((await listPendingApprovals(store, worker.record.id)).map(item => item.approvalId)).toEqual([second.sessionApproval!.approvalId]);
    ui.agent().confirmTool("no", second);
    await ui.until(successor.settled);
    expect(await successor.promise).toBe("no");
    expect(ui.stream).not.toHaveBeenCalled();
  });

  it("switches sessions without denying old consent or letting its stale prompt answer the new session", async () => {
    const old = await runtime();
    const next = await runtime();
    const ui = await mount(old.session);
    await ui.until(() => !!ui.agent().pendingConfirmation);
    const oldPrompt = ui.agent().pendingConfirmation!;
    ui.agent().loadSession(next.session);
    await ui.until(() => ui.agent().pendingConfirmation?.sessionApproval?.sessionId === next.record.id);
    const nextPrompt = ui.agent().pendingConfirmation!;
    ui.agent().confirmTool("yes", oldPrompt);
    await sleep(300);
    expect(old.first.settled()).toBe(false);
    expect(next.first.settled()).toBe(false);
    expect((await listPendingApprovals(store, old.record.id)).map(item => item.approvalId)).toEqual([oldPrompt.sessionApproval!.approvalId]);
    expect((await listPendingApprovals(store, next.record.id)).map(item => item.approvalId)).toEqual([nextPrompt.sessionApproval!.approvalId]);
    ui.agent().confirmTool("no", nextPrompt);
    await ui.until(next.first.settled);
    expect(await next.first.promise).toBe("no");
    // Another attachment can still answer the old worker after the switch.
    await decideSessionApproval(store, old.record.id, oldPrompt.sessionApproval!.approvalId, "yes");
    await ui.until(old.first.settled);
    expect(await old.first.promise).toBe("yes");
    expect(ui.stream).not.toHaveBeenCalled();
  });

  it("unmounts without resolving or denying the worker's pending request", async () => {
    const worker = await runtime();
    const ui = await mount(worker.session);
    await ui.until(() => !!ui.agent().pendingConfirmation);
    const prompt = ui.agent().pendingConfirmation!;
    ui.unmount();
    await sleep(300);
    expect(worker.first.settled()).toBe(false);
    expect((await listPendingApprovals(store, worker.record.id)).map(item => item.approvalId)).toEqual([prompt.sessionApproval!.approvalId]);
    await decideSessionApproval(store, worker.record.id, prompt.sessionApproval!.approvalId, "yes");
    await until(worker.first.settled);
    expect(await worker.first.promise).toBe("yes");
    expect(ui.stream).not.toHaveBeenCalled();
  });
});
