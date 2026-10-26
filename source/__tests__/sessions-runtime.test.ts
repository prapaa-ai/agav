import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { ConversationState } from "../agent/conversation.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { SessionApprovalBroker, decideSessionApproval, listPendingApprovals, type SessionApprovalRequest } from "../sessions/approvals.js";
import { createSessionExecution, sessionExecutionConfig, startSessionExecution, type SessionExecutionHandle } from "../sessions/runner.js";
import { ToolRegistry } from "../tools/registry.js";

let root: string;
let store: SessionRuntimeStore;
const brokers: SessionApprovalBroker[] = [];
const handles: SessionExecutionHandle[] = [];
const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 128,
  maxIterations: 3, errorRetries: 0, permissionMode: "ask", systemPrompt: "test" };
const request: SessionApprovalRequest = { toolName: "write_file", input: { path: "example", content: "hello" } };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-session-runtime-"));
  store = new SessionRuntimeStore(root);
});
afterEach(async () => {
  for (const broker of brokers.splice(0)) broker.clear();
  await Promise.all(handles.splice(0).map(handle => handle.shutdown()));
  await rm(root, { recursive: true, force: true });
});
async function runtime(overrides: Partial<AgavConfig> = {}) {
  const conversation = new ConversationState();
  conversation.addUserMessage("make a change");
  return createSessionExecution(store, { ...config, ...overrides }, { conversation });
}
function broker(id: string, generation: string) {
  const result = new SessionApprovalBroker(store, id, generation, { pollMs: 1 });
  brokers.push(result);
  return result;
}
async function pending(id: string, count = 1) {
  await vi.waitFor(async () => store.lock(id, async () => {
    expect(await listPendingApprovals(store, id)).toHaveLength(count);
  }));
  return listPendingApprovals(store, id);
}

describe("durable session approvals", () => {
  it("continues a terminal execution under one session id with a fresh fenced generation", async () => {
    const first = await runtime();
    await store.update(first.id, first.generation, record => { record.status = "completed"; record.title = "My session"; });
    const conversation = new ConversationState();
    conversation.addUserMessage("second turn");
    const second = await createSessionExecution(store, config, { id: first.id, previousGeneration: first.generation, conversation });
    expect(second.id).toBe(first.id);
    expect(second.generation).not.toBe(first.generation);
    expect(second.title).toBe("My session");
    expect(second.createdAt).toBe(first.createdAt);
    expect(await store.list()).toHaveLength(1);
    await expect(store.save(first)).rejects.toThrow(/stale/);
    await expect(createSessionExecution(store, config, { id: first.id, previousGeneration: first.generation, conversation })).rejects.toThrow(/stale|active/);
  });


  it("persists settings without credentials and rejects stale store writers", async () => {
    const record = await runtime({ anthropicApiKey: "secret", orgPermissionFloor: "ask", permissionMode: "auto-accept" });
    expect(await new SessionRuntimeStore(root).read(record.id)).toEqual(record);
    expect(record).toMatchObject({ status: "starting", permissionMode: "ask", backgroundPermissionMode: "ask" });
    expect(await readFile(join(store.directory(record.id), "runtime.json"), "utf8")).not.toContain("secret");
    await expect(store.save({ ...record, generation: "stale" })).rejects.toThrow(/stale/);
    const mutate = vi.fn();
    await expect(store.update(record.id, "stale", mutate)).rejects.toThrow(/stale/);
    expect(mutate).not.toHaveBeenCalled();
    expect(await store.read(record.id)).toEqual(record);
  });

  it("inherits the session override without widening independent job consent", async () => {
    const conversation = new ConversationState();
    conversation.addUserMessage("continue");
    const record = await createSessionExecution(store, config, { conversation, permissionMode: "auto-accept" });
    expect(record).toMatchObject({ permissionMode: "auto-accept", backgroundPermissionMode: "ask" });
    const tightened = sessionExecutionConfig(record, { ...config, orgPermissionFloor: "deny-writes" });
    expect(tightened.permissionMode).toBe("deny-writes");
    expect(tightened.orgPermissionFloor).toBe("deny-writes");
  });

  it("retains denial feedback and immutable invocation arguments across a fresh observer", async () => {
    const record = await runtime();
    const input = { path: "original.txt", content: "original" };
    const waiting = broker(record.id, record.generation).confirm({ toolName: "write_file", input });
    const [item] = await pending(record.id);
    input.path = "changed.txt";
    expect(item!.input.path).toBe("original.txt");
    const choice = { choice: "no" as const, feedback: "Use a different file" };
    await decideSessionApproval(new SessionRuntimeStore(root), record.id, item!.approvalId, choice);
    expect(await waiting).toEqual(choice);
    expect(await listPendingApprovals(store, record.id)).toEqual([]);
  });

  it.each(["starting", "running", "needs-approval"] as const)("discovers approvals from %s and reconciles status", async status => {
    const record = await runtime();
    const waiting = broker(record.id, record.generation).confirm(request);
    const [item] = await pending(record.id);
    expect((await store.read(record.id))?.status).toBe("needs-approval");
    await store.update(record.id, record.generation, current => { current.status = status; });
    expect(await listPendingApprovals(store)).toEqual([item]);
    await decideSessionApproval(new SessionRuntimeStore(root), record.id, item!.approvalId, "yes");
    expect(await waiting).toBe("yes");
    expect(await listPendingApprovals(store, record.id)).toEqual([]);
    expect((await store.read(record.id))?.status).toBe("running");
  });

  it("keeps concurrent requests pending until each is answered, with one durable decision winner", async () => {
    const record = await runtime();
    const owner = broker(record.id, record.generation);
    const first = owner.confirm(request);
    const second = owner.confirm({ ...request, input: { path: "second" } });
    const items = await pending(record.id, 2);
    const a = items.find(item => item.input.path === "example")!;
    const b = items.find(item => item.input.path === "second")!;
    const answers = await Promise.all(["yes", "no"].map(choice => decideSessionApproval(
      new SessionRuntimeStore(root), record.id, a.approvalId, choice as "yes" | "no")));
    expect(answers.map(answer => answer.won).sort()).toEqual([false, true]);
    expect(answers[0]!.record).toEqual(answers[1]!.record);
    expect(await first).toBe(answers[0]!.record.result);
    expect((await store.read(record.id))?.status).toBe("needs-approval");
    expect(await listPendingApprovals(store, record.id)).toEqual([b]);
    await decideSessionApproval(store, record.id, b.approvalId, "no");
    expect(await second).toBe("no");
    expect((await store.read(record.id))?.status).toBe("running");
  });

  it("rejects stale approval identities and generations without accepting a write", async () => {
    const record = await runtime();
    const owner = broker(record.id, record.generation);
    const waiting = owner.confirm(request);
    const [item] = await pending(record.id);
    for (const expected of [{ generation: "stale" }, { inputHash: "wrong" }]) {
      await expect(decideSessionApproval(store, record.id, item!.approvalId, "yes", expected)).rejects.toThrow(/stale/);
    }
    owner.clear();
    expect(await waiting).toBe("no");
    await expect(broker(record.id, "stale").confirm(request)).rejects.toThrow(/stale/);
    await store.update(record.id, record.generation, current => { current.status = "completed"; });
    expect(await listPendingApprovals(store, record.id)).toEqual([]);
    await expect(decideSessionApproval(store, record.id, item!.approvalId, "yes")).rejects.toThrow(/stale/);
  });

  it.each([
    { choice: "yes", expected: "yes" }, { choice: "no", expected: "no" },
    { choice: "always", expected: "always" },
    { choice: "always", expected: "no", explicitApprovalOnly: true },
    { choice: "yes", expected: "yes", explicitApprovalOnly: true },
    { choice: "always", expected: "yes", toolName: "run_background_job" },
    { choice: "always", expected: "yes", floor: "ask" },
  ] as const)("normalizes $choice to $expected ($explicitApprovalOnly / $toolName / $floor)", async test => {
    const record = await runtime("floor" in test ? { orgPermissionFloor: test.floor } : {});
    const owner = broker(record.id, record.generation);
    const waiting = owner.confirm({ ...request, ...("explicitApprovalOnly" in test ? { explicitApprovalOnly: true } : {}),
      ...("toolName" in test ? { toolName: test.toolName } : {}) });
    const [item] = await pending(record.id);
    const answer = await decideSessionApproval(store, record.id, item!.approvalId, test.choice);
    expect(answer.record.result).toBe(test.expected);
    expect(await waiting).toBe(test.expected);
  });

  it("Always drains generic requests but never bypasses explicit or background consent", async () => {
    const record = await runtime();
    const owner = broker(record.id, record.generation);
    const generic = owner.confirm(request);
    const queued = owner.confirm({ ...request, input: { path: "queued" } });
    const explicit = owner.confirm({ ...request, explicitApprovalOnly: true });
    const background = owner.confirm({ toolName: "run_background_job", input: { action: "start" } });
    const items = await pending(record.id, 4);
    const first = items.find(item => item.input.path === "example" && !item.explicitApprovalOnly)!;
    await decideSessionApproval(store, record.id, first.approvalId, "always");
    expect(await generic).toBe("always");
    expect(await queued).toBe("always");
    expect(await owner.confirm(request)).toBe("always");
    const remaining = await pending(record.id, 2);
    expect(remaining.some(item => item.explicitApprovalOnly)).toBe(true);
    expect(remaining.some(item => item.toolName === "run_background_job")).toBe(true);
    owner.clear();
    expect(await explicit).toBe("no");
    expect(await background).toBe("no");
    expect((await store.read(record.id))?.status).toBe("running");
  });
});

function execution(record: Awaited<ReturnType<typeof runtime>>) {
  let turn = 0;
  const provider: LLMProvider = { name: "mock", stream: vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> {
    if (turn++ === 0) {
      yield { type: "tool_call_start", toolCallId: "write", toolName: "test_write" };
      yield { type: "tool_call_delta", toolCallId: "write", argsJson: JSON.stringify(request.input) };
      yield { type: "tool_call_end", toolCallId: "write" };
      yield { type: "message_end", stopReason: "tool_calls" };
    } else {
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", stopReason: "end_turn" };
    }
  })()) };
  const execute = vi.fn(async () => ({ output: "written", isError: false }));
  const registry = new ToolRegistry();
  registry.register({ schema: { name: "test_write", description: "test write", inputSchema: { type: "object", properties: {} } }, execute });
  const handle = startSessionExecution(record.id, { store, config, provider, registry });
  handles.push(handle);
  return { handle, execute, provider };
}

describe("session execution worker", () => {
  it("refuses to rebind freshly loaded credentials or gateway headers to a stored endpoint", async () => {
    const record = await runtime({ provider: "openai", openaiBaseURL: "https://old.example/v1" });
    expect(() => sessionExecutionConfig(record, { ...config, provider: "openai",
      openaiBaseURL: "https://current.example/v1", openaiGatewayAuth: true,
      openaiHeaders: { Authorization: "Bearer current-org-token" } })).toThrow(/endpoint|routing/i);
    const local = { ...config, provider: "openai" as const, openaiBaseURL: "https://current.example/v1", openaiApiKey: "fresh-key" };
    expect(() => sessionExecutionConfig(record, local)).toThrow(/endpoint|routing/i);
    expect(sessionExecutionConfig(record, { ...local, openaiBaseURL: "https://old.example/v1" }).openaiBaseURL).toBe("https://old.example/v1");
  });

  it.each(["yes", "no"] as const)("pauses the actual loop until durable %s, then persists completion", async choice => {
    const record = await runtime();
    const { handle, execute, provider } = execution(record);
    const [item] = await pending(record.id);
    expect(execute).not.toHaveBeenCalled();
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect((await store.read(record.id))?.status).toBe("needs-approval");
    await decideSessionApproval(new SessionRuntimeStore(root), record.id, item!.approvalId, choice,
      { generation: record.generation, inputHash: item!.inputHash });
    const result = await handle.done;
    expect(result.status, result.error).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(choice === "yes" ? 1 : 0);
    expect(result.messages.flatMap(message => message.content)).toContainEqual(expect.objectContaining({ type: "tool_result", isError: choice === "no" }));
    expect(result.iterationsBudget?.remaining).toBe(1);
    expect(await store.read(record.id)).toEqual(result);
    const events = (await readFile(join(store.directory(record.id), "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", generation: record.generation });
    expect(await listPendingApprovals(store, record.id)).toEqual([]);
  });

  it.each(["auto-accept", "deny-writes"] as const)("honors persisted %s without publishing approval", async permissionMode => {
    const record = await runtime({ permissionMode });
    const { handle, execute } = execution(record);
    const result = await handle.done;
    expect(result.status, result.error).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(permissionMode === "auto-accept" ? 1 : 0);
    expect(await listPendingApprovals(store, record.id)).toEqual([]);
    await expect(readFile(join(store.directory(record.id), "approvals"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an old worker invocation after the session advances to another generation", async () => {
    const first = await runtime();
    await store.update(first.id, first.generation, record => { record.status = "completed"; });
    const conversation = new ConversationState();
    conversation.addUserMessage("new task");
    const next = await createSessionExecution(store, config, { id: first.id, previousGeneration: first.generation, conversation });
    const provider: LLMProvider = { name: "mock", stream: vi.fn(async function* () {}) };
    const handle = startSessionExecution(next.id, { store, config, provider, registry: new ToolRegistry(), expectedGeneration: first.generation });
    handles.push(handle);
    await expect(handle.done).rejects.toThrow(/stale/i);
    expect(provider.stream).not.toHaveBeenCalled();
    expect((await store.read(next.id))!.generation).toBe(next.generation);
  });

  it("rejects an existing execution owner before streaming or running tools", async () => {
    const record = await runtime();
    await writeFile(join(store.directory(record.id), `owner-${record.generation}.json`), JSON.stringify({ generation: record.generation, pid: process.pid }));
    const { handle, execute, provider } = execution(record);
    await expect(handle.done).rejects.toThrow(/already has an execution owner/);
    expect(provider.stream).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect((await store.read(record.id))?.status).toBe("starting");
  });
});
