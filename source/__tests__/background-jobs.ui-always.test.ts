import { EventEmitter } from "node:events";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import render from "../ink/render.js";
import { useAgent } from "../hooks/use-agent.js";
import { createAuthorizationService } from "../background-jobs/authorization/service.js";
import { createGrantStore } from "../background-jobs/authorization/grant-store.js";
import { DEFAULT_RESOURCE_LIMITS, BackgroundJobError } from "../background-jobs/types.js";
import type { LLMProvider } from "../providers/types.js";

// Real UI hook, queue, loop, registry and exact-spec authorization; no user
// storage or actual workloads. Only launch coordination and UI persistence
// /context discovery are substituted.
vi.mock("../config/config.js", () => ({ loadConfig: async () => ({ backgroundJobsEnabled: true, permissionMode: "ask" }) }));
vi.mock("../config/history.js", () => ({ saveSession: vi.fn(async () => "fixture-session") }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(), loadPlan: async () => null, clearPlan: vi.fn(), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));
const shared = vi.hoisted(() => ({ coordinator: null as any }));
vi.mock("../background-jobs-integration.js", () => ({ getSharedCoordinator: async () => shared.coordinator }));
let root: string;
let agent: ReturnType<typeof useAgent>;
let instance: ReturnType<typeof render>;
let nextCall: { name: string; input: Record<string, unknown> };
let completed: number;
const spec = { invocation: { mode: "shell" as const, interpreter: "cmd" as const, commandText: "echo consent" }, cwd: process.cwd(), env: {}, credentialRefs: [], isolation: { backend: "none" as const, required: false }, ownershipScope: "unverified" as const, limits: DEFAULT_RESOURCE_LIMITS, headless: false };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-ui-always-"));
  completed = 0;
  const auth = createAuthorizationService(root);
  shared.coordinator = { start: vi.fn(async (request, session) => {
    const decision = await auth.authorize("start", { ...structuredClone(spec), invocation: request.invocation, cwd: request.cwd }, session);
    if (!decision.allowed) throw new BackgroundJobError("authorization-denied", decision.reason);
    return { jobId: "approved-job", state: "accepted" };
  }) };
  let emitCall = true;
  const provider: LLMProvider = { name: "fixture", async *stream() {
    if (emitCall) {
      emitCall = false;
      yield { type: "tool_call_start", toolCallId: "fixture", toolName: nextCall.name };
      yield { type: "tool_call_delta", toolCallId: "fixture", argsJson: JSON.stringify(nextCall.input) };
      yield { type: "tool_call_end", toolCallId: "fixture" };
      yield { type: "message_end", stopReason: "tool_calls" };
    } else {
      emitCall = true;
      completed++;
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", stopReason: "end_turn" };
    }
  } };
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  function App() {
    agent = useAgent(provider, { provider: "anthropic", model: "fixture", effort: "low", maxTokens: 1000, maxIterations: 3, errorRetries: 0, permissionMode: "ask" });
    return null;
  }
  instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await instance.waitUntilRenderFlush();
});
afterEach(async () => {
  agent.cancel();
  instance.unmount();
  await rm(root, { recursive: true, force: true });
});
async function submit(name: string, input: Record<string, unknown>) {
  nextCall = { name, input };
  expect(await agent.submit("fixture turn")).toBe(true);
}
async function finish(count: number) {
  await vi.waitFor(() => { expect(completed).toBe(count); expect(agent.isLoading).toBe(false); });
}
async function pending(name: string) {
  await vi.waitFor(() => expect(agent.pendingConfirmation?.toolName).toBe(name));
}
describe("UI Always consent boundary across parent turns", () => {
  it("background Always grants only the displayed spec, not changed specs or generic tools", async () => {
    await submit("run_background_job", { action: "start", command: "echo consent" });
    await pending("run_background_job");
    expect(agent.pendingConfirmation?.input.spec).toBeDefined();
    agent.confirmTool("always");
    await finish(1);
    expect(await createGrantStore(root).list()).toHaveLength(1);

    // Same exact spec reuses its grant without prompting.
    await submit("run_background_job", { action: "start", command: "echo consent" });
    await finish(2);
    expect(agent.pendingConfirmation).toBeNull();
    expect(await createGrantStore(root).list()).toHaveLength(1);

    await submit("run_background_job", { action: "start", command: "echo changed" });
    await pending("run_background_job");
    agent.confirmTool("no");
    await finish(3);
    expect(await createGrantStore(root).list()).toHaveLength(1);

    // Unknown generic tool is harmless but still needs generic confirmation.
    await submit("fixture_generic", {});
    await pending("fixture_generic");
    agent.confirmTool("no");
    await finish(4);
  });
  it("generic Always still skips later generic prompts but never grants new background specs", async () => {
    await submit("fixture_generic", {});
    await pending("fixture_generic");
    agent.confirmTool("always");
    await finish(1);
    await submit("fixture_generic", { later: true });
    await finish(2);
    expect(agent.pendingConfirmation).toBeNull();
    await submit("run_background_job", { action: "start", command: "echo new background" });
    await pending("run_background_job");
    agent.confirmTool("no");
    await finish(3);
    expect(await createGrantStore(root).list()).toHaveLength(0);
  });
});
