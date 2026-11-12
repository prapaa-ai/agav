import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../agent/loop.js";
import type { SubagentProgress } from "../agent/subagent-types.js";
import { runAgentLoop } from "../agent/loop.js";
import { createSubagentTool } from "../tools/subagent.js";
import { ToolRegistry } from "../tools/registry.js";

vi.mock("../agent/loop.js", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../commands/steer.js", () => ({
	formatSteersForPrompt: () => "",
	createSteerQueue: () => ({ drain: () => [], dispose: vi.fn() }),
}));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	return { promise, release };
}

describe("subagent usage-only progress", () => {
	it("coalesces usage bursts after earlier progress has flushed and clears the pending broadcast on completion", async () => {
		vi.useFakeTimers();
		const emitUsage = gate();
		const finish = gate();
		vi.mocked(runAgentLoop).mockImplementation(() => (async function* (): AsyncGenerator<AgentEvent> {
			yield { type: "streaming_text", text: "waiting" };
			await emitUsage.promise;
			for (let index = 0; index < 50; index++) {
				yield { type: "usage", inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 };
			}
			await finish.promise;
			yield { type: "turn_complete" };
		})());
		// Snapshot callback arguments: production progress entries are mutable.
		const onProgressUpdate = vi.fn((states: SubagentProgress[]) => structuredClone(states));
		const onTokenUsage = vi.fn();
		const tool = createSubagentTool({
			provider: { name: "mock", stream: vi.fn() }, parentToolRegistry: new ToolRegistry(),
			getConfig: () => ({ model: "mock", systemPrompt: "test", permissionMode: "auto-accept", effort: "low",
				iterationsBudget: { remaining: 1, total: 1 } }),
			confirmationQueue: { enqueue: vi.fn(), rejectBySubagentId: vi.fn() },
			onProgressUpdate, onTokenUsage, getSignal: () => undefined,
		});
		const execution = tool.execute({ title: "Inspect", task: "Inspect the fixture" });
		try {
			await vi.advanceTimersByTimeAsync(70);
			expect(onProgressUpdate).toHaveBeenCalledTimes(1);
			expect(onProgressUpdate.mock.results[0]!.value[0].tokenUsage.inputTokens).toBe(0);
			emitUsage.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(onTokenUsage).toHaveBeenCalledTimes(50);
			expect(onProgressUpdate).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(66);
			expect(onProgressUpdate).toHaveBeenCalledTimes(2);
			expect(onProgressUpdate.mock.results[1]!.value[0]).toMatchObject({
				status: "running", tokenUsage: { inputTokens: 100, outputTokens: 150, cacheReadTokens: 200 },
			});
			finish.release();
			await execution;
			expect(onProgressUpdate.mock.results.at(-1)!.value[0].status).toBe("done");
			await vi.advanceTimersByTimeAsync(100);
			expect(onProgressUpdate.mock.results.at(-1)!.value).toEqual([]);
			const count = onProgressUpdate.mock.calls.length;
			await vi.advanceTimersByTimeAsync(500);
			expect(onProgressUpdate).toHaveBeenCalledTimes(count);
		} finally {
			emitUsage.release(); finish.release();
			await execution;
			await vi.runAllTimersAsync();
		}
	});
});
