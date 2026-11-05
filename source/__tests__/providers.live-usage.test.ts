import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";

const mocks = vi.hoisted(() => ({ anthropic: vi.fn(), responses: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { stream: mocks.anthropic }; } }));
vi.mock("openai", () => ({ default: class { responses = { create: mocks.responses }; } }));

import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import { GeminiProvider } from "../providers/gemini.js";
import { VertexAIAuth, VertexAIProvider } from "../providers/vertex-ai.js";

async function* replay(items: unknown[]) { yield* items; }
const params = { model: "claude-sonnet-4-5", messages: [] };
async function collect(provider: LLMProvider) {
	const events: StreamEvent[] = [];
	for await (const event of provider.stream(params)) events.push(event);
	return events;
}
const usages = (events: Array<StreamEvent | AgentEvent>) => events.filter(event => event.type === "usage");
function claude(vertex: boolean, chunks: unknown[]) {
	mocks.anthropic.mockImplementation(() => replay(chunks));
	vi.spyOn(VertexAIAuth.prototype, "getAccessToken").mockResolvedValue("token");
	vi.spyOn(VertexAIAuth.prototype, "getProjectId").mockResolvedValue("project");
	vi.stubGlobal("fetch", vi.fn(async () => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(""))));
	return vertex ? new VertexAIProvider("unused") : new AnthropicProvider("unused");
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("provider cumulative usage regressions", () => {
	it.each([false, true])("normalizes Claude input/output/cache snapshots per request (Vertex=%s)", async vertex => {
		const provider = claude(vertex, [
			{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } },
			{ type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 4 } },
			{ type: "message_delta", delta: {}, usage: { output_tokens: 4 } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } },
		]);
		for (let request = 0; request < 2; request++) {
			const events = await collect(provider);
			expect(usages(events)).toEqual([
				{ type: "usage", inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 },
				{ type: "usage", inputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
				{ type: "usage", inputTokens: 2, outputTokens: 3, cacheReadTokens: 3, cacheWriteTokens: 3 },
			]);
			expect(events.filter(event => event.type === "message_end")).toEqual([{ type: "message_end", stopReason: "end_turn" }]);
		}
	});

	it.each([false, true])("preserves initial Claude output before termination (Vertex=%s)", async vertex => {
		const stream = claude(vertex, [
			{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 2 } } },
			{ type: "message_delta", delta: { stop_reason: null } },
		]).stream(params)[Symbol.asyncIterator]();
		expect((await stream.next()).value).toEqual({ type: "message_start" });
		expect((await stream.next()).value).toEqual({ type: "usage", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
		expect((await stream.next()).done).toBe(true);
	});

	it.each(["max_output_tokens", "content_filter"])("accounts and ends an incomplete Responses result (%s)", async reason => {
		mocks.responses.mockImplementation(() => replay([
			{ type: "response.output_text.delta", delta: "partial answer" },
			{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason }, usage: { input_tokens: 100, output_tokens: 128, input_tokens_details: { cached_tokens: 90 } } } },
		]));
		const events = await collect(new OpenAIProvider("unused", "responses"));
		expect(events.slice(-2)).toEqual([
			{ type: "usage", inputTokens: 100, outputTokens: 128, cacheReadTokens: 90 },
			{ type: "message_end", stopReason: reason },
		]);
	});

	it("accounts failed Responses usage before surfacing the API error", async () => {
		mocks.responses.mockImplementation(() => replay([
			{ type: "response.failed", response: { status: "failed", error: { message: "generation failed" }, usage: { input_tokens: 100, output_tokens: 7 } } },
		]));
		const events = await collect(new OpenAIProvider("unused", "responses"));
		expect(events.slice(-2)).toEqual([
			{ type: "usage", inputTokens: 100, outputTokens: 7, cacheReadTokens: 0 },
			{ type: "error", error: new Error("generation failed") },
		]);
	});

	it.each(["response.incomplete", "response.failed"])("handles %s without usage", async type => {
		mocks.responses.mockImplementation(() => replay([{ type, response: {} }]));
		const events = await collect(new OpenAIProvider("unused", "responses"));
		expect(usages(events)).toEqual([]);
		expect(events.at(-1)).toEqual(type === "response.failed"
			? { type: "error", error: new Error("Response failed") }
			: { type: "message_end", stopReason: "incomplete" });
	});

	it.each(["response.completed", "response.incomplete", "response.failed"])("stops after %s without counting a repeated terminal event", async type => {
		const terminal = { type, response: { status: type.slice("response.".length), usage: { input_tokens: 10, output_tokens: 2 } } };
		mocks.responses.mockImplementation(() => replay([terminal, terminal, { type: "response.output_text.delta", delta: "too late" }]));
		const events = await collect(new OpenAIProvider("unused", "responses"));
		expect(usages(events)).toEqual([{ type: "usage", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }]);
		expect(events.filter(event => event.type === "text_delta")).toEqual([]);
	});

	it.each([false, true])("isolates overlapping Claude usage on one provider (Vertex=%s)", async vertex => {
		const provider = claude(vertex, [
			{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
		]);
		const expected = [
			{ type: "usage", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
			{ type: "usage", inputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
		];
		const events = await Promise.all([collect(provider), collect(provider)]);
		expect(events.map(usages)).toEqual([expected, expected]);
	});

	it("preserves received Gemini usage when a subsequent read fails", async () => {
		let reads = 0;
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read: async () => {
			if (reads++ === 0) return { done: false, value: new TextEncoder().encode('data: {"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7,"thoughtsTokenCount":3,"cachedContentTokenCount":90},"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n') };
			throw new Error("network stream interrupted");
		} }) } })));
		const conversation = new ConversationState();
		conversation.addUserMessage("Hello");
		const events: AgentEvent[] = [];
		for await (const event of runAgentLoop({ provider: new GeminiProvider("unused"), conversation, model: "mock", toolRegistry: new ToolRegistry(), iterationsBudget: { remaining: 2, total: 2 } })) events.push(event);
		expect(events).toContainEqual({ type: "streaming_text", text: "partial" });
		expect(usages(events)).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: undefined }]);
		expect(events.at(-1)).toMatchObject({ type: "error" });
	});

	it("publishes Gemini usage before asking for the next network chunk", async () => {
		const read = vi.fn().mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: {"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7}}\n\n') }).mockResolvedValue({ done: true });
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read }) } })));
		const stream = new GeminiProvider("unused").stream(params)[Symbol.asyncIterator]();
		expect((await stream.next()).value).toEqual({ type: "message_start" });
		expect((await stream.next()).value).toEqual({ type: "usage", inputTokens: 100, outputTokens: 7, cacheReadTokens: 0 });
		expect(read).toHaveBeenCalledTimes(1);
		await stream.return?.();
	});
});
