import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { SessionRecord } from "../config/history.js";
import type { LLMProvider } from "../providers/types.js";

let root: string;
const modes = vi.hoisted(() => [] as string[]);
vi.mock("../config/config.js", async original => ({ ...await original<typeof import("../config/config.js")>(), getAgavDir: () => root }));
vi.mock("../agent/loop.js", async original => {
  const real = await original<typeof import("../agent/loop.js")>();
  return { ...real, runAgentLoop: async function* (params: Parameters<typeof real.runAgentLoop>[0]) {
    modes.push(params.permissionMode ?? "ask");
    yield* real.runAgentLoop(params);
  } };
});
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../skills/improvement.js", () => ({ maybeRunBackgroundImprovement: async () => {} }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(async () => {}), loadPlan: async () => null, clearPlan: vi.fn(async () => {}), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));

import { useAgent } from "../hooks/use-agent.js";
import render from "../ink/render.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { loadResumableSession } from "../sessions/history.js";
import { loadSession, saveSessionRuntime } from "../config/history.js";
import { resolveResumePermissionMode } from "../config/startup.js";
import { permissionCommand } from "../commands/permission.js";

const base: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 0, permissionMode: "ask" };
let store: SessionRuntimeStore;
const mounts: ReturnType<typeof render>[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agav-review-permissions-")); store = new SessionRuntimeStore(); modes.length = 0; });
afterEach(async () => { for (const ui of mounts.splice(0)) ui.unmount(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
async function runtime(status: "running" | "completed" = "completed") {
  const record = await store.create({ cwd: root, provider: "anthropic", model: "mock", permissionMode: "ask", sandboxRequired: false,
    messages: [{ role: "user", content: [{ type: "text", text: "worker transcript" }] }] });
  const updated = await store.update(record.id, record.generation, current => { current.status = status; });
  await saveSessionRuntime(updated, store);
  return (await loadResumableSession(record.id))!;
}
async function mount(session: SessionRecord, resolved?: AgavConfig["permissionMode"], floor?: AgavConfig["permissionMode"]) {
  const config = { ...base, orgPermissionFloor: floor };
  const provider: LLMProvider = { name: "mock", async *stream() { yield { type: "text_delta", text: "done" }; } };
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  let agent!: ReturnType<typeof useAgent>;
  function App() { agent = useAgent(provider, config, session.messages, session.id, session.tokenUsage, session.compacted, session.name, session.runtime, resolved); return null; }
  const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  mounts.push(instance);
  await instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(agent.messages.some(message => message.content === "worker transcript")).toBe(true));
  // Each new transcript is proof of an actual disk-polling snapshot.
  async function snapshot(text: string) {
    await store.update(session.id, session.runtime!.generation, current => { current.messages.push({ role: "assistant", content: [{ type: "text", text }] }); });
    await vi.waitFor(() => expect(agent.messages.some(message => message.content === text)).toBe(true));
  }
  return { agent: () => agent, snapshot, config };
}

describe("review: attached session permissions", () => {
  it("keeps a CLI-resolved override through snapshots and the next submission", async () => {
    const session = await runtime();
    const resolved = resolveResumePermissionMode(base, { cliPermissionMode: "deny-writes", savedPermissionMode: session.permissionMode });
    const ui = await mount(session, resolved);
    await ui.snapshot("CLI snapshot");
    expect(ui.agent().getEffectivePermissionMode()).toBe("deny-writes");
    await vi.waitFor(async () => expect((await store.read(session.id))?.permissionMode).toBe("deny-writes"));
    expect(await ui.agent().submit("continue")).toBe(true);
    await vi.waitFor(() => expect(modes).toEqual(["deny-writes"]));
    await vi.waitFor(() => expect(ui.agent().isLoading).toBe(false));
  });

  it("persists /permission metadata without replacing the worker transcript and uses it next turn", async () => {
    const session = await runtime();
    const ui = await mount(session);
    await ui.snapshot("latest worker output");
    // A stale local conversation must never become the persisted worker transcript.
    ui.agent().conversation.addUserMessage("local-only stale data");
    await permissionCommand.execute("deny-writes", { config: ui.config, getEffectivePermissionMode: ui.agent().getEffectivePermissionMode,
      setPermissionMode: ui.agent().setSessionPermissionMode } as never);
    await ui.snapshot("permission snapshot");
    expect(ui.agent().getEffectivePermissionMode()).toBe("deny-writes");
    await vi.waitFor(async () => expect((await loadSession(session.id))?.permissionMode).toBe("deny-writes"));
    const record = (await store.read(session.id))!;
    expect(record.permissionMode).toBe("deny-writes");
    expect(JSON.stringify(record.messages)).not.toContain("local-only stale data");
    expect((await loadResumableSession(session.id))?.permissionMode).toBe("deny-writes");
    expect(await ui.agent().submit("continue")).toBe(true);
    await vi.waitFor(() => expect(modes).toEqual(["deny-writes"]));
    await vi.waitFor(() => expect(ui.agent().isLoading).toBe(false));
  });

  it("retains local changes while a worker is live and persists them when terminal, clamped to org floor", async () => {
    const session = await runtime("running");
    const ui = await mount(session, undefined, "deny-writes");
    expect(ui.agent().setSessionPermissionMode("auto-accept")).toBe("deny-writes");
    await ui.snapshot("live snapshot");
    expect(ui.agent().getEffectivePermissionMode()).toBe("deny-writes");
    expect((await store.read(session.id))?.permissionMode).toBe("ask");
    await store.update(session.id, session.runtime!.generation, current => { current.status = "completed"; });
    await ui.snapshot("terminal snapshot");
    await vi.waitFor(async () => expect((await loadSession(session.id))?.permissionMode).toBe("deny-writes"));
    expect((await store.read(session.id))?.permissionMode).toBe("deny-writes");
  });

  it("uses authoritative runtime policy rather than stale saved history during resume", async () => {
    const session = await runtime();
    await store.update(session.id, session.runtime!.generation, current => { current.permissionMode = "deny-writes"; });
    expect((await loadResumableSession(session.id))?.permissionMode).toBe("deny-writes");
  });

  it("restores saved permissions on loadSession and clears local overrides on a fresh session", async () => {
    const session = await runtime();
    const ui = await mount(session, "auto-accept");
    ui.agent().loadSession({ id: "legacy", createdAt: "2026-01-01", model: "mock", provider: "anthropic", title: "Legacy", messages: [], permissionMode: "deny-writes" });
    expect(ui.agent().getEffectivePermissionMode()).toBe("deny-writes");
    ui.agent().clearMessages();
    expect(ui.agent().getEffectivePermissionMode()).toBe("ask");
  });
});
