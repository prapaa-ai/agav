import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import { createToolRegistry } from "../tools/registry-factory.js";
import { createAuthorizationService } from "../background-jobs/authorization/service.js";
import { createGrantStore } from "../background-jobs/authorization/grant-store.js";
import { createFileRepositories } from "../background-jobs/storage/repositories.js";
import { createScheduleEngine } from "../background-jobs/schedule/engine.js";
import { DEFAULT_RESOURCE_LIMITS, BackgroundJobError } from "../background-jobs/types.js";
import { createSubagentTool } from "../tools/subagent.js";

vi.mock("../config/config.js", () => ({ loadConfig: async () => ({ backgroundJobsEnabled: true, permissionMode: "ask" }) }));
vi.mock("../utils/worktree.js", () => ({ createWorktree: async () => null, removeWorktree: async () => {}, applyWorktreeChanges: async () => ({ applied: true }) }));
const shared = vi.hoisted(() => ({ coordinator: null as any, engine: null as any }));
vi.mock("../background-jobs-integration.js", () => ({ getSharedCoordinator: async () => shared.coordinator, getSharedScheduleEngine: async () => shared.engine }));
let root: string;
const spec = { invocation: { mode: "shell" as const, interpreter: "cmd" as const, commandText: "echo consent" }, cwd: process.cwd(), env: {}, credentialRefs: [], isolation: { backend: "none" as const, required: false }, ownershipScope: "unverified" as const, limits: DEFAULT_RESOURCE_LIMITS, headless: false };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-ask-flow-"));
  const auth = createAuthorizationService(root);
  shared.coordinator = { start: vi.fn(async (request, session) => {
    const normalized = { ...structuredClone(spec), invocation: request.invocation, cwd: request.cwd };
    const decision = await auth.authorize("start", normalized, session);
    if (!decision.allowed) throw new BackgroundJobError("authorization-denied", decision.reason);
    return { jobId: "approved-job", state: "accepted" };
  }) };
  shared.engine = createScheduleEngine({ root, repositories: createFileRepositories(root), authorizationService: auth, coordinator: shared.coordinator });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function provider(input: Record<string, unknown>) {
  let turn = 0;
  return { name: "mock", async *stream() {
    if (turn++ === 0) {
      yield { type: "tool_call_start", toolCallId: "bg", toolName: "run_background_job" };
      yield { type: "tool_call_delta", toolCallId: "bg", argsJson: JSON.stringify(input) };
      yield { type: "tool_call_end", toolCallId: "bg" };
      yield { type: "message_end", stopReason: "tool_calls" };
    } else { yield { type: "text_delta", text: "done" }; yield { type: "message_end", stopReason: "end_turn" }; }
  } } as any;
}
async function run(input: Record<string, unknown>, confirmTool?: any, signal?: AbortSignal, permissionMode: "ask" | "deny-writes" = "ask") {
  const conversation = new ConversationState(); conversation.addUserMessage("background task");
  const events = [];
  for await (const event of runAgentLoop({ provider: provider(input), conversation, toolRegistry: createToolRegistry(), model: "test", permissionMode, confirmTool, signal })) events.push(event);
  return events;
}
describe("background authorization through the actual tool factory and loop", () => {
  it.each(["start", "schedule-create"])("parent %s prompts once for normalized consent and persists approval", async action => {
    const confirm = vi.fn(async (_name, input) => { expect(input.spec.isolation.backend).toBe("none"); expect(input.spec.cwd).toBe(process.cwd()); return "yes"; });
    const events = await run({ action, command: "echo consent", cron: "0 9 * * *", timezone: "UTC" }, confirm);
    expect(events.find(e => e.type === "tool_result")?.isError).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await createGrantStore(root).list()).toHaveLength(1);
  });
  it.each(["no", "throw"])("parent rejection %s leaves no grant", async choice => {
    const events = await run({ action: "start", command: "echo consent" }, async () => { if (choice === "throw") throw Error("closed"); return choice; });
    expect(events.find(e => e.type === "tool_result")?.isError).toBe(true);
    expect(await createGrantStore(root).list()).toHaveLength(0);
  });
  it("no callback and deny-writes fail closed", async () => {
    expect((await run({ action: "start", command: "echo consent" })).find(e => e.type === "tool_result")?.isError).toBe(true);
    const confirm = vi.fn(async () => "yes");
    expect((await run({ action: "start", command: "echo consent" }, confirm, undefined, "deny-writes")).find(e => e.type === "tool_result")?.isError).toBe(true);
    expect(confirm).not.toHaveBeenCalled(); expect(await createGrantStore(root).list()).toHaveLength(0);
  });
  it("subagent consent includes identity and cancellation rejects the pending action", async () => {
    const queue = new ConfirmationQueue(); let pending: any;
    queue.bind(item => { pending = item; });
    const tool = createSubagentTool({ provider: provider({ action: "start", command: "echo consent" }), parentToolRegistry: createToolRegistry(), getConfig: () => ({ model: "test", systemPrompt: "test", permissionMode: "ask", effort: "medium", maxIterations: 2 }), confirmationQueue: queue, onProgressUpdate: () => {}, onTokenUsage: () => {}, getSignal: () => undefined });
    const result = tool.execute({ title: "background", task: "launch background task" });
    await vi.waitFor(() => expect(pending).toBeTruthy());
    expect(pending.subagentId).toBe("sa-1"); expect(pending.input.spec).toBeDefined();
    tool.cancelSubagent("sa-1"); expect((await result).isError).toBe(true);
    expect(await createGrantStore(root).list()).toHaveLength(0);
  });
  it("generic Always preserves already queued background confirmations", async () => {
    const queue = new ConfirmationQueue(); let shown: any;
    queue.bind(item => { shown = item; });
    const generic = queue.enqueue({ toolName: "write_file", input: {} });
    const background = queue.enqueue({ toolName: "run_background_job", input: { action: "start", spec } });
    const other = queue.enqueue({ toolName: "edit_file", input: {} });
    queue.resolve("always");
    expect(await generic).toBe("always"); expect(await other).toBe("always");
    expect(shown?.toolName).toBe("run_background_job");
    queue.resolve("no"); expect(await background).toBe("no");
  });
  it("background Always does not approve queued generic writes", async () => {
    const queue = new ConfirmationQueue(); let shown: any;
    queue.bind(item => { shown = item; });
    const background = queue.enqueue({ toolName: "run_background_job", input: { action: "start", spec } });
    const generic = queue.enqueue({ toolName: "write_file", input: {} });
    queue.resolve("always"); expect(await background).toBe("yes");
    expect(shown?.toolName).toBe("write_file");
    queue.resolve("no"); expect(await generic).toBe("no");
  });
  it("queue never auto-approves background consent or escalates its Always choice", async () => {
    const queue = new ConfirmationQueue(); let shown: any;
    queue.bind(item => { shown = item; });
    const generic = queue.enqueue({ toolName: "write_file", input: {} }); queue.resolve("always"); await generic;
    const bg = queue.enqueue({ toolName: "run_background_job", input: { action: "start", spec } });
    expect(shown?.toolName).toBe("run_background_job"); queue.resolve("always"); expect(await bg).toBe("yes");
    const next = queue.enqueue({ toolName: "run_background_job", input: { action: "start", spec: { ...spec, cwd: "changed" } } });
    expect(shown).toBeTruthy(); queue.clear(); expect(await next).toBe("no");
  });
});
