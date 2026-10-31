import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";

const boundary = vi.hoisted(() => ({
  provider: null as LLMProvider | null,
  agent: undefined as ReturnType<typeof import("../hooks/use-agent.js").useAgent> | undefined,
  prompt: undefined as any,
  config: undefined as AgavConfig | undefined,
}));
// Observe the real hook; neither submit, intervention, cancellation nor the loop is replaced.
vi.mock("../hooks/use-agent.js", async importOriginal => {
  const original = await importOriginal<typeof import("../hooks/use-agent.js")>();
  return { ...original, useAgent: (...args: Parameters<typeof original.useAgent>) => {
    boundary.config = args[1];
    boundary.agent = original.useAgent(...args);
    return boundary.agent;
  } };
});
vi.mock("../providers/registry.js", () => ({ createProvider: () => boundary.provider }));
vi.mock("../components/input-prompt.js", () => ({ default: (props: any) => { boundary.prompt = props; return null; } }));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../config/history.js", () => ({
  saveSession: vi.fn(async () => "session"),
  listSessions: vi.fn(async () => []),
  loadSession: vi.fn(async () => null),
}));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(async () => {}), loadPlan: async () => null, clearPlan: vi.fn(async () => {}), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));
vi.mock("../skills/improvement.js", () => ({ maybeRunBackgroundImprovement: async () => {} }));

import { saveSession, listSessions, loadSession, type SessionRecord } from "../config/history.js";
import { resolveResumePermissionMode } from "../config/startup.js";

let instance: ReturnType<typeof render>;
let keyboard: NodeJS.ReadStream;
const base: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 1, permissionMode: "ask" };
const saved = (permissionMode?: AgavConfig["permissionMode"]): SessionRecord => ({ id: "other", createdAt: "2026-01-01", model: "mock", provider: "anthropic", title: "Other", messages: [], permissionMode });
async function mount(config = base, resumePermissionMode?: AgavConfig["permissionMode"]) {
  boundary.provider = { name: "mock", async *stream() { yield { type: "text_delta", text: "done" }; yield { type: "message_end", stopReason: "end_turn" }; } };
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  keyboard = stdin;
  instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS, resumePermissionMode }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(boundary.prompt).toBeDefined());
}
async function command(text: string) {
  await boundary.prompt.onSubmit(text);
  await instance.waitUntilRenderFlush();
}
function expectMode(mode: AgavConfig["permissionMode"]) {
  expect(boundary.agent!.getEffectivePermissionMode()).toBe(mode);
  // This is the config consumed by background jobs/workflows and child agents.
  expect(boundary.config!.permissionMode).toBe(mode);
}
beforeEach(() => { vi.clearAllMocks(); boundary.prompt = undefined; });
afterEach(() => { boundary.agent?.cancel(); instance?.unmount(); });

describe("session permission integration", () => {
  it("resets /permission overrides on /new and legacy /resume", async () => {
    await mount();
    await command("/permission auto-accept");
    expectMode("auto-accept");
    await command("/new");
    expectMode("ask");
    await command("/permission auto-accept");
    vi.mocked(listSessions).mockResolvedValue([saved()]);
    vi.mocked(loadSession).mockResolvedValue(saved());
    await command("/resume other");
    expectMode("ask");
  });
  it("synchronizes foreground and background permissions on in-app resume", async () => {
    await mount();
    await command("/permission auto-accept");
    vi.mocked(listSessions).mockResolvedValue([saved("deny-writes")]);
    vi.mocked(loadSession).mockResolvedValue(saved("deny-writes"));
    await command("/resume other");
    expectMode("deny-writes");
  });
  it("restores CLI-resumed mode in config without changing /new defaults", async () => {
    await mount(base, resolveResumePermissionMode(base, { savedPermissionMode: "auto-accept" }));
    expectMode("auto-accept");
    await command("/new");
    expectMode("ask");
  });
  it.each(["auto-accept", "deny-writes"] as const)("honors CLI override %s through App and hook", async (mode) => {
    const config = { ...base, permissionMode: mode };
    await mount(config, resolveResumePermissionMode(config, { cliPermissionMode: mode, savedPermissionMode: mode === "auto-accept" ? "deny-writes" : "auto-accept" }));
    expectMode(mode);
  });
  it("clamps resumed and explicit modes to org policy", async () => {
    await mount({ ...base, orgPermissionFloor: "deny-writes" });
    await command("/permission auto-accept");
    expectMode("deny-writes");
    vi.mocked(listSessions).mockResolvedValue([saved("auto-accept")]);
    vi.mocked(loadSession).mockResolvedValue(saved("auto-accept"));
    await command("/resume other");
    expectMode("deny-writes");
    await command("/new");
    expectMode("deny-writes");
  });
  it.each(["ask", "auto-accept", "deny-writes"] as const)("persists effective default %s on saveNow and turn completion", async (mode) => {
    await mount({ ...base, permissionMode: mode });
    boundary.agent!.conversation.addUserMessage("hello");
    boundary.agent!.saveNow();
    await vi.waitFor(() => expect(vi.mocked(saveSession).mock.calls.at(-1)?.[8]).toBe(mode));
    vi.mocked(saveSession).mockClear();
    await command("hello");
    await vi.waitFor(() => expect(vi.mocked(saveSession).mock.calls.at(-1)?.[8]).toBe(mode));
  });
  it("persists a changed mode immediately", async () => {
    await mount();
    await command("/permission deny-writes");
    await vi.waitFor(() => expect(vi.mocked(saveSession).mock.calls.at(-1)?.[8]).toBe("deny-writes"));
  });
});


describe("interactive permission picker in App", () => {
  async function key(text: string) {
    keyboard.emit("data", Buffer.from(text));
    await new Promise(resolve => setTimeout(resolve, 80));
    await instance.waitUntilRenderFlush();
  }

  it("opens, disables the composer, applies a selection and saves it", async () => {
    await mount();
    const pending = boundary.prompt.onSubmit("/permission");
    await vi.waitFor(() => expect(boundary.prompt.disabled).toBe(true));
    await key("\x1b[B"); // auto-accept
    expectMode("ask"); // navigation must not change the policy
    await key("\r");
    await pending;
    await vi.waitFor(() => expect(boundary.prompt.disabled).toBe(false));
    expectMode("auto-accept");
    expect(vi.mocked(saveSession).mock.calls.at(-1)?.[8]).toBe("auto-accept");
    await command("/new");
    expectMode("ask");
  });

  it("cancels without writing and allows the picker to reopen", async () => {
    await mount();
    for (let i = 0; i < 2; i++) {
      const pending = boundary.prompt.onSubmit("/permission");
      await vi.waitFor(() => expect(boundary.prompt.disabled).toBe(true));
      await key("\x1b[B");
      await key("\x1b");
      await pending;
      await vi.waitFor(() => expect(boundary.prompt.disabled).toBe(false));
      expectMode("ask");
    }
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("does not apply policy-blocked selections", async () => {
    await mount({ ...base, orgPermissionFloor: "ask" });
    const pending = boundary.prompt.onSubmit("/permission");
    await vi.waitFor(() => expect(boundary.prompt.disabled).toBe(true));
    await key("\x1b[B");
    await key("\r");
    expect(boundary.prompt.disabled).toBe(true);
    expectMode("ask");
    expect(saveSession).not.toHaveBeenCalled();
    await key("\x1b[B"); // deny-writes remains allowed
    await key("\r");
    await pending;
    expectMode("deny-writes");
  });
});
