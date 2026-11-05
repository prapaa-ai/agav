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
function toolEvents(kind: Kind): StreamEvent[] {
	const input = kind === "subagent"
		? { title: "Inspect fixture", task: "Inspect the fixture" }
		: { name: skill.name, arguments: "fixture" };
	return [
		{ type: "tool_call_start", toolName: kind, toolCallId: kind },
		{ type: "tool_call_delta", toolCallId: kind, argsJson: JSON.stringify(input) },
		{ type: "tool_call_end", toolCallId: kind },
	];
}
async function start(provider: LLMProvider) {
	const conversation = new ConversationState();
	conversation.addUserMessage("Inspect the fixture");
	const record = await createSessionExecution(store, config, { conversation });
	const events: AgentEvent[] = [];
	const handle = startSessionExecution(record.id, {
		store, config, provider, registry: new ToolRegistry(), prepareTools: prepareSessionTools,
		onEvent: event => { events.push(event); },
	});
	handles.push(handle);
	return { record, handle, events };
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
});
