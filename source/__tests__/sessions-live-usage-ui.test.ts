import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { useAgent } from "../hooks/use-agent.js";
import render from "../ink/render.js";
import StatusBar from "../components/status-bar.js";
import SubagentDisplay from "../components/subagent-display.js";
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
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../skills/loader.js", () => ({
	loadSkills: async () => [skill],
	getCachedSkills: () => [skill],
	getSkill: (name: string) => name === skill.name || name === skill.slug ? skill : undefined,
}));
vi.mock("../skills/improvement.js", () => ({ recordSkillTrace: async () => {}, maybeRunBackgroundImprovement: async () => {} }));
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
function toolEvents(kind: Kind, toolCallId: string = kind): StreamEvent[] {
	const input = kind === "subagent"
		? { title: "Inspect fixture", task: "Inspect the fixture" }
		: { name: skill.name, arguments: "fixture" };
	return [
		{ type: "tool_call_start", toolName: kind, toolCallId },
		{ type: "tool_call_delta", toolCallId, argsJson: JSON.stringify(input) },
		{ type: "tool_call_end", toolCallId },
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

vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(async () => {}), loadPlan: async () => null, clearPlan: vi.fn(async () => {}), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));

async function mountUI(id: string) {
	const session = (await loadResumableSession(id))!;
	const chunks: string[] = [];
	const stdout = new EventEmitter() as NodeJS.WriteStream;
	Object.assign(stdout, { isTTY: true, columns: 160, rows: 30, write: (text: string) => { chunks.push(text); return true; } });
	const stdin = new EventEmitter() as NodeJS.ReadStream;
	Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
	let agent!: ReturnType<typeof useAgent>;
	function App() {
		agent = useAgent(null, config, session.messages, session.id, session.tokenUsage, session.compacted, session.name, session.runtime);
		return h("ink-box", {}, h(StatusBar, { model: "mock", provider: "mock", effort: "low", messageCount: 1, ...agent.tokenUsage }),
			...agent.subagentStates.map(progress => h(SubagentDisplay, { key: progress.id, progress, mode: "compact" })));
	}
	const instance = render(h(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
	await instance.waitUntilRenderFlush();
	return { agent: () => agent, instance, text: () => chunks.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") };
}

describe("worker-to-UI delegated progress", () => {
	it.each(kinds)("publishes usage-only %s row/footer updates and preserves final/resumed totals", async kind => {
		const emitUsage = gate();
		const childFinish = gate();
		const parentFinish = gate();
		let turn = 0;
		const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
			if (turn++ === 0) {
				yield { type: "usage", ...parentFirst };
				yield* toolEvents(kind);
				yield { type: "message_end", stopReason: "tool_calls" };
			} else if (turn === 2) {
				yield { type: "text_delta", text: "child waiting" };
				await waitForGate(emitUsage.promise, params.signal);
				yield { type: "usage", ...childFirst };
				await waitForGate(childFinish.promise, params.signal);
				yield { type: "text_delta", text: "child done" };
				yield { type: "message_end", stopReason: "end_turn" };
			} else {
				await waitForGate(parentFinish.promise, params.signal);
				yield { type: "usage", ...parentLast };
				yield { type: "text_delta", text: "parent done" };
				yield { type: "message_end", stopReason: "end_turn" };
			}
		} };
		const { record, handle } = await start(provider);
		await expectLive(record.id, parentFirst);
		const ui = await mountUI(record.id);
		try {
			await vi.waitFor(() => expect(ui.agent().tokenUsage).toEqual(parentFirst));
			await vi.waitFor(() => expect(ui.agent().subagentStates[0]?.streamingText).toBe("child waiting"));
			// All earlier progress has reached disk/UI before usage-only activity.
			await new Promise(resolve => setTimeout(resolve, 350));
			emitUsage.release();
			await expectLive(record.id, sum(parentFirst, childFirst));
			await vi.waitFor(() => expect(ui.agent().tokenUsage).toEqual(sum(parentFirst, childFirst)), { timeout: 2000 });
			await ui.instance.waitUntilRenderFlush();
			expect(ui.text()).toContain("120 ↑ 24 ↓ 11 ⇢");
			await vi.waitFor(() => expect(ui.agent().subagentStates).toEqual([expect.objectContaining({
				status: "running", tokenUsage: { inputTokens: 19, outputTokens: 11, cacheReadTokens: 4 },
			})]), { timeout: 2000 });
			childFinish.release();
			await vi.waitFor(() => expect(turn).toBe(3));
			await new Promise(resolve => setTimeout(resolve, 350));
			expect(ui.agent().tokenUsage).toEqual(sum(parentFirst, childFirst));
			parentFinish.release();
			await expectFinal(handle, sum(parentFirst, childFirst, parentLast));
			await vi.waitFor(() => expect(ui.agent().isLoading).toBe(false), { timeout: 2000 });
			expect(ui.agent().tokenUsage).toEqual(sum(parentFirst, childFirst, parentLast));
			expect(ui.agent().subagentStates).toEqual([]);
			await new Promise(resolve => setTimeout(resolve, 550));
			expect(ui.agent().tokenUsage).toEqual(sum(parentFirst, childFirst, parentLast));
		} finally { ui.instance.unmount(); }
		const resumed = await mountUI(record.id);
		try {
			await vi.waitFor(() => expect(resumed.agent().isLoading).toBe(false), { timeout: 2000 });
			expect(resumed.agent().tokenUsage).toEqual(sum(parentFirst, childFirst, parentLast));
		} finally { resumed.instance.unmount(); }
	});

	it.each(["finish", "error", "cancel"] as const)("preserves concurrent subagent/skill rows through %s and never resurrects settled rows", async outcome => {
		const usageGates = [gate(), gate(), gate()];
		const finishGates = [gate(), gate(), gate()];
		const parentFinish = gate();
		let parentTurn = 0;
		let skillCalls = 0;
		const usages = [childFirst, otherChild, childFirst];
		const provider: LLMProvider = { name: "mock", async *stream(params): AsyncGenerator<StreamEvent> {
			const isSkill = params.systemPrompt?.includes('You are executing the "Usage fixture" skill');
			const isSubagent = params.systemPrompt?.includes("You are a subagent working");
			if (isSkill || isSubagent) {
				const index = isSkill ? ++skillCalls : 0;
				yield { type: "text_delta", text: `child ${index} waiting` };
				await waitForGate(usageGates[index]!.promise, params.signal);
				yield { type: "usage", ...usages[index]! };
				await waitForGate(finishGates[index]!.promise, params.signal);
				if (outcome === "error") yield { type: "error", error: new Error(`child ${index} failed`) };
				else {
					yield { type: "text_delta", text: `child ${index} done` };
					yield { type: "message_end", stopReason: "end_turn" };
				}
			} else if (parentTurn++ === 0) {
				yield { type: "usage", ...parentFirst };
				yield* toolEvents("subagent");
				yield* toolEvents("activate_skill", "skill-a");
				yield* toolEvents("activate_skill", "skill-b");
				yield { type: "message_end", stopReason: "tool_calls" };
			} else {
				await waitForGate(parentFinish.promise, params.signal);
				yield { type: "usage", ...parentLast };
				yield { type: "text_delta", text: "parent done" };
				yield { type: "message_end", stopReason: "end_turn" };
			}
		} };
		const { record, handle, events } = await start(provider);
		await expectLive(record.id, parentFirst);
		const ui = await mountUI(record.id);
		try {
			await vi.waitFor(() => expect(ui.agent().subagentStates).toHaveLength(3), { timeout: 2000 });
			const rows = ui.agent().subagentStates;
			expect(new Set(rows.map(row => row.id)).size).toBe(3);
			expect(rows.filter(row => row.title === `Skill: ${skill.name}`)).toHaveLength(2);
			const skillIds = rows.filter(row => row.title === `Skill: ${skill.name}`).map(row => row.id);
			// Subagent broadcasts and each skill's functional updater must retain
			// the other two rows, including when only token usage changes.
			for (let index = 0; index < 3; index++) {
				usageGates[index]!.release();
				const total = sum(parentFirst, ...usages.slice(0, index + 1));
				await expectLive(record.id, total);
				await vi.waitFor(() => {
					expect(ui.agent().tokenUsage).toEqual(total);
					expect(ui.agent().subagentStates).toHaveLength(3);
					expect(ui.agent().subagentStates.find(row => row.streamingText === `child ${index} waiting`)?.tokenUsage)
						.toEqual({ inputTokens: usages[index]!.inputTokens, outputTokens: usages[index]!.outputTokens,
							cacheReadTokens: usages[index]!.cacheReadTokens });
				}, { timeout: 2000 });
			}
			if (outcome === "cancel") {
				await handle.shutdown();
				await expectFinal(handle, sum(parentFirst, ...usages), "interrupted");
				expect(parentTurn).toBe(1);
			} else {
				// A subagent's delayed removal must not remove either live skill.
				finishGates[0]!.release();
				// Parent tool results arrive only after the entire parallel batch.
				await vi.waitFor(() => {
					if (outcome === "finish") expect(ui.agent().subagentStates).toHaveLength(2);
					else expect(ui.agent().subagentStates.find(row => row.id === "sa-1"))
						.toMatchObject({ status: "error", error: "child 0 failed" });
				}, { timeout: 2000 });
				expect(ui.agent().subagentStates.filter(row => skillIds.includes(row.id)))
					.toEqual(skillIds.map(id => expect.objectContaining({ id, status: "running" })));
				finishGates[1]!.release();
				finishGates[2]!.release();
				await vi.waitFor(() => {
					expect(parentTurn).toBe(2);
					expect(ui.agent().subagentStates.filter(row => skillIds.includes(row.id)))
						.toEqual(skillIds.map(id => expect.objectContaining({ id, status: outcome === "error" ? "error" : "done" })));
				}, { timeout: 2000 });
				for (const kind of kinds) expect(events).toContainEqual(expect.objectContaining({
					type: "tool_result", toolName: kind, isError: outcome === "error",
				}));
				parentFinish.release();
				await expectFinal(handle, sum(parentFirst, ...usages, parentLast));
			}
			await vi.waitFor(() => expect(ui.agent().isLoading).toBe(false), { timeout: 2000 });
			expect(ui.agent().subagentStates).toEqual([]);
			const total = sum(parentFirst, ...usages, ...(outcome === "cancel" ? [] : [parentLast]));
			expect(ui.agent().tokenUsage).toEqual(total);
			// Drain delayed child broadcasts, tracker flushes and UI polling.
			await new Promise(resolve => setTimeout(resolve, 550));
			expect(ui.agent().subagentStates).toEqual([]);
			expect(await new SessionRuntimeStore().read(record.id)).toMatchObject({ subagentStates: [], tokenUsage: total });
		} finally { ui.instance.unmount(); }
	});

});
