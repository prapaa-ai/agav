import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../config/config.js";
import type { AgavConfig } from "../config/config.js";
import { loadSession, type SessionTokenUsage } from "../config/history.js";
import { ConversationState } from "../agent/conversation.js";
import type { AgentEvent } from "../agent/loop.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { loadResumableSession } from "../sessions/history.js";
import { listPendingApprovals } from "../sessions/approvals.js";
import { requestSessionSubagentCancellation } from "../sessions/client.js";
import { createSessionExecution, prepareSessionTools, startSessionExecution, type SessionExecutionHandle } from "../sessions/runner.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import type { SkillDefinition } from "../skills/types.js";
import { ToolRegistry } from "../tools/registry.js";

// Only discovery and incidental disk writes are mocked: registration, delegated
// execution, both agent loops, runtime checkpoints, and history are all real.
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [] }));
vi.mock("../skills/loader.js", () => ({
	loadSkills: async () => [skill],
	getCachedSkills: () => [skill],
	getSkill: (name: string) => name === skill.name || name === skill.slug ? skill : undefined,
}));
vi.mock("../skills/improvement.js", () => ({ recordSkillTrace: async () => {} }));
vi.mock("../utils/worktree.js", () => ({
	createWorktree: vi.fn(async () => null),
	removeWorktree: vi.fn(async () => {}),
	applyWorktreeChanges: vi.fn(async () => ({ applied: true })),
}));

const skill: SkillDefinition = {
	name: "Usage fixture", slug: "usage-fixture", description: "Inspect the fixture",
	body: "Inspect the fixture: $ARGUMENTS", origin: "project", filePath: "/unused/SKILL.md",
	frontmatter: { name: "Usage fixture", description: "Inspect the fixture", invocation: "agav" },
};
const config: AgavConfig = {
	provider: "anthropic", model: "mock", effort: "low", maxTokens: 128,
	maxIterations: 10, errorRetries: 0, permissionMode: "auto-accept", systemPrompt: "Usage fixture",
};
const parentFirst = { inputTokens: 101, outputTokens: 13, cacheReadTokens: 7, cacheWriteTokens: 3 };
const parentLast = { inputTokens: 31, outputTokens: 17, cacheReadTokens: 5, cacheWriteTokens: 2 };
const childFirst = { inputTokens: 19, outputTokens: 11, cacheReadTokens: 4, cacheWriteTokens: 6 };
const childLast = { inputTokens: 23, outputTokens: 29, cacheReadTokens: 0, cacheWriteTokens: 0 };
const otherChild = { inputTokens: 37, outputTokens: 41, cacheReadTokens: 43, cacheWriteTokens: 47 };
const kinds = ["subagent", "activate_skill"] as const;
type Kind = typeof kinds[number];
let root: string;
let store: SessionRuntimeStore;
const handles: SessionExecutionHandle[] = [];
const releases: Array<() => void> = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "agav-session-usage-"));
	vi.spyOn(configModule, "getAgavDir").mockReturnValue(root);
	store = new SessionRuntimeStore();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(handles.splice(0).map(handle => handle.shutdown()));
	// Real subagents remove their final progress entry after 100ms.
	await new Promise(resolve => setTimeout(resolve, 150));
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	releases.push(release);
	return { promise, release };
}
async function waitForGate(promise: Promise<void>, signal?: AbortSignal) {
	if (signal?.aborted) return;
	let onAbort!: () => void;
	const aborted = new Promise<void>(resolve => { onAbort = resolve; });
	signal?.addEventListener("abort", onAbort, { once: true });
	try { await Promise.race([promise, aborted]); }
	finally { signal?.removeEventListener("abort", onAbort); }
}
function sum(...usages: SessionTokenUsage[]): SessionTokenUsage {
	return usages.reduce((total, usage) => ({
		inputTokens: total.inputTokens + usage.inputTokens,
		outputTokens: total.outputTokens + usage.outputTokens,
		cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
		cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
	}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
}
function toolEvents(kind: Kind, toolCallId: string = kind, args = "fixture"): StreamEvent[] {
	const input = kind === "subagent"
		? { title: "Inspect fixture", task: "Inspect the fixture" }
		: { name: skill.name, arguments: args };
	return [
		{ type: "tool_call_start", toolName: kind, toolCallId },
		{ type: "tool_call_delta", toolCallId, argsJson: JSON.stringify(input) },
		{ type: "tool_call_end", toolCallId },
	];
}
async function start(provider: LLMProvider, options: { config?: Partial<AgavConfig>; registry?: ToolRegistry } = {}) {
	const sessionConfig = { ...config, ...options.config };
	let signal: AbortSignal | undefined;
	const conversation = new ConversationState();
	conversation.addUserMessage("Inspect the fixture");
	const record = await createSessionExecution(store, sessionConfig, { conversation });
	const events: AgentEvent[] = [];
	const handle = startSessionExecution(record.id, {
		store, config: sessionConfig, provider, registry: options.registry ?? new ToolRegistry(),
		prepareTools: async context => { signal = context.signal; return prepareSessionTools(context); },
		onEvent: event => { events.push(event); },
	});
	handles.push(handle);
	return { record, handle, events, get signal() { return signal; } };
}
async function expectLive(id: string, tokenUsage: SessionTokenUsage) {
	// A separate reader must see usage while the provider is still blocked;
	// neither a child completion nor a later parent event can drive this flush.
	await vi.waitFor(async () => {
		expect(await new SessionRuntimeStore().read(id)).toMatchObject({ status: "running", tokenUsage });
	}, { timeout: 3000, interval: 20 });
	expect(await loadResumableSession(id)).toMatchObject({ tokenUsage, runtime: { status: "running" } });
}
async function expectFinal(handle: SessionExecutionHandle, tokenUsage: SessionTokenUsage, status = "completed") {
	const result = await handle.done;
	expect(result).toMatchObject({ status, tokenUsage });
	expect(await new SessionRuntimeStore().read(result.id)).toMatchObject({ status, tokenUsage });
	expect(await loadSession(result.id)).toMatchObject({ tokenUsage });
	expect(await loadResumableSession(result.id)).toMatchObject({ tokenUsage, runtime: { status } });
}

describe("durable delegated token accounting", () => {
	it.each(kinds)("includes %s deltas live and exactly once in final runtime/history", async kind => {
		const childFinish = gate();
		const parentFinish = gate();
		let turn = 0;
		const stream = vi.fn((_params: Parameters<LLMProvider["stream"]>[0]) => (async function* (): AsyncGenerator<StreamEvent> {
			const current = turn++;
			if (current === 0) {
				yield { type: "usage", ...parentFirst };
				yield* toolEvents(kind);
				yield { type: "message_end", stopReason: "tool_calls" };
			} else if (current === 1) {
				yield { type: "usage", ...childFirst };
				// Omitted cache fields must contribute zero, not reset existing totals.
				yield { type: "usage", inputTokens: childLast.inputTokens, outputTokens: childLast.outputTokens };
				await waitForGate(childFinish.promise, _params.signal);
				yield { type: "text_delta", text: "child done" };
				yield { type: "message_end", stopReason: "end_turn" };
			} else {
				await waitForGate(parentFinish.promise, _params.signal);
				yield { type: "usage", ...parentLast };
				yield { type: "text_delta", text: "parent done" };
				yield { type: "message_end", stopReason: "end_turn" };
			}
		})());
		const { record, handle } = await start({ name: "mock", stream });
		await expectLive(record.id, sum(parentFirst, childFirst, childLast));
		expect(stream).toHaveBeenCalledTimes(2);
		childFinish.release();
		await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(3));
		await expectLive(record.id, sum(parentFirst, childFirst, childLast));
		parentFinish.release();
		await expectFinal(handle, sum(parentFirst, childFirst, childLast, parentLast));
		expect(stream).toHaveBeenCalledTimes(3);
	});

	it.each(kinds)("retains %s usage when its child reports a provider error", async kind => {
		const finish = gate();
		let turn = 0;
		const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
			const current = turn++;
			if (current === 0) {
				yield { type: "usage", ...parentFirst };
				yield* toolEvents(kind);
				yield { type: "message_end", stopReason: "tool_calls" };
			} else if (current === 1) {
				yield { type: "usage", ...childFirst };
				await waitForGate(finish.promise, params.signal);
				yield { type: "error", error: new Error("fixture provider failure") };
			} else {
				yield { type: "usage", ...parentLast };
				yield { type: "text_delta", text: "child failed" };
				yield { type: "message_end", stopReason: "end_turn" };
			}
		} };
		const { record, handle, events } = await start(provider);
		await expectLive(record.id, sum(parentFirst, childFirst));
		finish.release();
		await expectFinal(handle, sum(parentFirst, childFirst, parentLast));
		expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", toolName: kind,
			isError: true, output: expect.stringContaining("fixture provider failure") }));
	});

	it.each(kinds)("retains %s usage when the worker is cancelled before child completion", async kind => {
		const finish = gate();
		let turn = 0;
		const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
			if (turn++ === 0) {
				yield { type: "usage", ...parentFirst };
				yield* toolEvents(kind);
				yield { type: "message_end", stopReason: "tool_calls" };
			} else {
				yield { type: "usage", ...childFirst };
				await waitForGate(finish.promise, params.signal);
				yield { type: "text_delta", text: "unreachable after cancellation" };
				yield { type: "message_end", stopReason: "end_turn" };
			}
		} };
		const { record, handle } = await start(provider);
		await expectLive(record.id, sum(parentFirst, childFirst));
		await handle.shutdown();
		await expectFinal(handle, sum(parentFirst, childFirst), "interrupted");
		expect(turn).toBe(2);
	});

	it("adds concurrent subagent and skill deltas without replacing either child or counting completion twice", async () => {
		const childFinish = gate();
		const skillUsage = gate();
		const parentFinish = gate();
		let parentTurn = 0;
		const entered = new Set<Kind>();
		const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
			const kind = params.systemPrompt?.includes('You are executing the "Usage fixture" skill') ? "activate_skill"
				: params.systemPrompt?.includes("You are a subagent working") ? "subagent" : undefined;
			if (kind) {
				entered.add(kind);
				if (kind === "activate_skill") await waitForGate(skillUsage.promise, params.signal);
				yield { type: "usage", ...(kind === "subagent" ? childFirst : otherChild) };
				await waitForGate(childFinish.promise, params.signal);
				yield { type: "text_delta", text: `${kind} done` };
				yield { type: "message_end", stopReason: "end_turn" };
			} else if (parentTurn++ === 0) {
				yield { type: "usage", ...parentFirst };
				for (const child of kinds) yield* toolEvents(child);
				yield { type: "message_end", stopReason: "tool_calls" };
			} else {
				await waitForGate(parentFinish.promise, params.signal);
				yield { type: "usage", ...parentLast };
				yield { type: "text_delta", text: "both done" };
				yield { type: "message_end", stopReason: "end_turn" };
			}
		} };
		const { record, handle } = await start(provider);
		await vi.waitFor(() => expect(entered).toEqual(new Set(kinds)));
		await expectLive(record.id, sum(parentFirst, childFirst));
		skillUsage.release();
		await expectLive(record.id, sum(parentFirst, childFirst, otherChild));
		expect(parentTurn).toBe(1);
		childFinish.release();
		await vi.waitFor(() => expect(parentTurn).toBe(2));
		await expectLive(record.id, sum(parentFirst, childFirst, otherChild));
		parentFinish.release();
		await expectFinal(handle, sum(parentFirst, childFirst, otherChild, parentLast));
	});

	it("cancels only the selected skill progress ID among concurrent skills and a subagent", async () => {
		const childFinish = gate();
		const parentFinish = gate();
		const signals = new Map<string, AbortSignal | undefined>();
		let parentTurn = 0;
		const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
			const child = params.systemPrompt?.includes('You are executing the "Usage fixture" skill')
				? JSON.stringify(params.messages.at(-1)?.content).includes("cancel-target") ? "cancel-target" : "sibling-skill"
				: params.systemPrompt?.includes("You are a subagent working") ? "subagent" : undefined;
			if (child) {
				signals.set(child, params.signal);
				yield { type: "usage", ...(child === "cancel-target" ? childFirst : child === "sibling-skill" ? childLast : otherChild) };
				await waitForGate(childFinish.promise, params.signal);
				yield { type: "text_delta", text: `${child} done` };
				yield { type: "message_end", stopReason: "end_turn" };
			} else if (parentTurn++ === 0) {
				yield { type: "usage", ...parentFirst };
				yield* toolEvents("activate_skill", "target-call", "cancel-target");
				yield* toolEvents("activate_skill", "sibling-call", "sibling-skill");
				yield* toolEvents("subagent");
				yield { type: "message_end", stopReason: "tool_calls" };
			} else {
				await waitForGate(parentFinish.promise, params.signal);
				yield { type: "usage", ...parentLast };
				yield { type: "text_delta", text: "siblings completed after targeted cancellation" };
				yield { type: "message_end", stopReason: "end_turn" };
			}
		} };
		const execution = await start(provider);
		const { record, handle, events } = execution;
		const liveUsage = sum(parentFirst, childFirst, childLast, otherChild);
		await expectLive(record.id, liveUsage);
		await vi.waitFor(async () => {
			const states = (await store.read(record.id))!.subagentStates!;
			expect(states).toHaveLength(3);
			expect(states.every(state => state.status === "running")).toBe(true);
		}, { timeout: 3000, interval: 20 });
		const states = (await store.read(record.id))!.subagentStates!;
		const target = states.find(state => state.task === "cancel-target")!;
		expect(target).toBeDefined();
		expect(new Set(states.map(state => state.id)).size).toBe(3);
		expect(signals.size).toBe(3);
		await requestSessionSubagentCancellation(record.id, record.generation, target.id, new SessionRuntimeStore());
		await vi.waitFor(() => expect(signals.get("cancel-target")?.aborted).toBe(true), { timeout: 3000, interval: 20 });
		expect(signals.get("sibling-skill")?.aborted).toBe(false);
		expect(signals.get("subagent")?.aborted).toBe(false);
		expect(execution.signal?.aborted).toBe(false);
		expect(parentTurn).toBe(1);
		await vi.waitFor(async () => {
			const current = (await store.read(record.id))!.subagentStates!;
			expect(current.find(state => state.id === target.id)).toMatchObject({ status: "error" });
			expect(current.filter(state => state.id !== target.id).map(state => state.status)).toEqual(["running", "running"]);
		}, { timeout: 3000, interval: 20 });
		await expectLive(record.id, liveUsage);
		childFinish.release();
		await vi.waitFor(() => expect(parentTurn).toBe(2));
		expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", toolCallId: "target-call",
			toolName: "activate_skill", isError: true, output: expect.stringMatching(/abort|cancel/i) }));
		for (const toolCallId of ["sibling-call", "subagent"]) {
			expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", toolCallId, isError: false }));
		}
		expect(execution.signal?.aborted).toBe(false);
		parentFinish.release();
		await expectFinal(handle, sum(liveUsage, parentLast));
	});

	it("cancels a skill waiting for broker approval without aborting its parent or executing the destructive tool", async () => {
		const parentFinish = gate();
		const execute = vi.fn(async () => ({ output: "fixture written", isError: false }));
		const registry = new ToolRegistry();
		registry.register({ schema: { name: "usage_write", description: "Write a fixture",
			inputSchema: { type: "object", properties: { path: { type: "string" } } } }, execute });
		let parentTurn = 0;
		let childTurns = 0;
		const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
			if (params.systemPrompt?.includes('You are executing the "Usage fixture" skill')) {
				childTurns++;
				yield { type: "usage", ...childFirst };
				yield { type: "tool_call_start", toolName: "usage_write", toolCallId: "write-call" };
				yield { type: "tool_call_delta", toolCallId: "write-call", argsJson: '{"path":"fixture.txt"}' };
				yield { type: "tool_call_end", toolCallId: "write-call" };
				yield { type: "message_end", stopReason: "tool_calls" };
			} else if (parentTurn++ === 0) {
				yield { type: "usage", ...parentFirst };
				yield* toolEvents("activate_skill");
				yield { type: "message_end", stopReason: "tool_calls" };
			} else {
				await waitForGate(parentFinish.promise, params.signal);
				yield { type: "usage", ...parentLast };
				yield { type: "text_delta", text: "skill cancelled; parent continues" };
				yield { type: "message_end", stopReason: "end_turn" };
			}
		} };
		const execution = await start(provider, { registry, config: { permissionMode: "ask" } });
		const { record, handle, events } = execution;
		await vi.waitFor(async () => {
			expect(await listPendingApprovals(store, record.id)).toEqual([
				expect.objectContaining({ toolName: "usage_write", input: { path: "fixture.txt" } }),
			]);
			expect(await store.read(record.id)).toMatchObject({ status: "needs-approval",
				tokenUsage: sum(parentFirst, childFirst), subagentStates: [expect.objectContaining({ title: `Skill: ${skill.name}` })] });
		}, { timeout: 3000, interval: 20 });
		const target = (await store.read(record.id))!.subagentStates![0]!;
		expect(execute).not.toHaveBeenCalled();
		await requestSessionSubagentCancellation(record.id, record.generation, target.id, new SessionRuntimeStore());
		await vi.waitFor(() => expect(parentTurn).toBe(2), { timeout: 3000, interval: 20 });
		// Check while the parent is still running: terminal-session filtering must
		// not hide an orphaned pending approval.
		await expectLive(record.id, sum(parentFirst, childFirst));
		expect(await listPendingApprovals(new SessionRuntimeStore(), record.id)).toEqual([]);
		expect(execution.signal?.aborted).toBe(false);
		expect(execute).not.toHaveBeenCalled();
		expect(childTurns).toBe(1);
		expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", toolName: "activate_skill",
			isError: true, output: expect.stringMatching(/abort|cancel/i) }));
		parentFinish.release();
		await expectFinal(handle, sum(parentFirst, childFirst, parentLast));
	});

});
