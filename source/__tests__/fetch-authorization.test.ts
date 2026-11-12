import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, type ConfirmResult } from "../agent/loop.js";
import { ConfirmationQueue, type QueuedConfirmation } from "../agent/confirmation-queue.js";
import { ConversationState } from "../agent/conversation.js";
import { executeNativeAgent } from "../agents/executor.js";
import type { AgentDefinition } from "../agents/types.js";
import type { AgavConfig, PermissionMode } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { setFetchTransport, type Transport } from "../tools/fetch-url.js";
import { ToolRegistry } from "../tools/registry.js";
import { createDefaultAgentInvoker, type AgentInvokeRequest } from "../workflows/agent-invoker.js";
import { agentToolVerdict, confirmAgentTool } from "../workflows/gated-tools.js";
import { isReadOnlyHttpMethod, normalizeHttpMethod } from "../utils/http-method.js";

const url = "https://example.com/records";
let dir: string;
let transport: ReturnType<typeof vi.fn<Transport>>;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "agav-fetch-auth-"));
	transport = vi.fn<Transport>().mockResolvedValue({ status: 204, statusText: "No Content", cancel() {} });
	setFetchTransport(transport);
});
afterEach(async () => {
	setFetchTransport(undefined);
	await rm(dir, { recursive: true, force: true });
});

function scripted(method: string | undefined): LLMProvider {
	const turns: StreamEvent[][] = [[
		{ type: "tool_call_start", toolCallId: "f", toolName: "fetch_url" },
		{ type: "tool_call_delta", toolCallId: "f", argsJson: JSON.stringify({ url, method }) },
	], [{ type: "text_delta", text: "done" }]];
	return { name: "fixture", async *stream() { yield* turns.shift() ?? []; } };
}
function config(permissionMode: PermissionMode): AgavConfig {
	return { model: "fixture", effort: "low", maxTokens: 1000, maxIterations: 3, permissionMode } as AgavConfig;
}
function agent(): AgentDefinition {
	return {
		manifest: { name: "fetch-auth-fixture", description: "test", version: "1", "native-tools": ["fetch_url"] },
		systemPrompt: "test", tools: [], origin: "project", path: dir,
	};
}
async function native(method: string | undefined, permissionMode: PermissionMode, confirmTool?: () => Promise<ConfirmResult>) {
	return executeNativeAgent(agent(), "fetch", { provider: scripted(method), config: config(permissionMode), permissionMode, confirmTool });
}
async function workflow(method: string | undefined, permissionMode: PermissionMode, confirm?: AgentInvokeRequest["confirmTool"], allowedTools?: string[]) {
	const full = { ...config(permissionMode), allowedTools };
	return createDefaultAgentInvoker({ provider: scripted(method), config: full }).invoke({
		agent: agent(), task: "fetch", signal: new AbortController().signal, cwd: dir,
		confirmTool: confirm ?? ((name, input) => confirmAgentTool(name, input as Record<string, unknown>, full, new AbortController().signal, undefined, { nodeId: "n" })),
	});
}
async function loop(method: string, overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
	const execute = vi.fn(async () => ({ output: "ok", isError: false }));
	const registry = new ToolRegistry();
	registry.register({ schema: { name: "fetch_url", description: "fetch", destructive: false, inputSchema: { type: "object", properties: {} } }, execute });
	const conversation = new ConversationState();
	conversation.addUserMessage("fetch");
	for await (const _ of runAgentLoop({ provider: scripted(method), conversation, toolRegistry: registry, model: "fixture", permissionMode: "auto-accept", iterationsBudget: { remaining: 3, total: 3 }, ...overrides })) { /* drain */ }
	return execute;
}

describe("mutating fetch requires real per-call authorization", () => {
	it.each(["POST", "PUT", "DELETE", "PATCH"])("native auto-accept never synthesizes consent for %s", async method => {
		await native(method, "auto-accept");
		expect(transport).not.toHaveBeenCalled();
	});
	it.each(["POST", "PUT", "DELETE", "PATCH"])("workflow auto-accept without a host blocks %s", async method => {
		await workflow(method, "auto-accept");
		expect(transport).not.toHaveBeenCalled();
	});
	it.each(["ask", "auto-accept"] as const)("workflow %s uses the supplied callback, even with a fetch allowlist", async mode => {
		const confirm = vi.fn(async () => false);
		await workflow("POST", mode, confirm, ["fetch_url"]);
		expect(confirm).toHaveBeenCalledOnce();
		expect(transport).not.toHaveBeenCalled();
	});
	it("workflow auto-accept executes an explicitly approved mutation once", async () => {
		const confirm = vi.fn(async () => true);
		await workflow("POST", "auto-accept", confirm);
		expect(confirm).toHaveBeenCalledOnce();
		expect(transport).toHaveBeenCalledOnce();
	});
	it("native auto-accept executes an explicitly approved mutation once", async () => {
		const confirm = vi.fn(async (): Promise<ConfirmResult> => "yes");
		await native("POST", "auto-accept", confirm);
		expect(confirm).toHaveBeenCalledOnce();
		expect(transport).toHaveBeenCalledOnce();
	});
	it.each(["yes", "always"] as const)("deny-writes blocks a mutation despite callback returning %s", async answer => {
		const confirm = vi.fn(async () => answer);
		await native("POST", "deny-writes", confirm);
		await workflow("POST", "deny-writes", async () => true);
		expect(confirm).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});
	it.each([undefined, "GET", "HEAD"])("native and workflow reads (%s) stay available without a host in deny-writes", async method => {
		await native(method, "deny-writes");
		await workflow(method, "deny-writes");
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it.each(["ask", "auto-accept", "deny-writes"] as const)("GET/HEAD remain read-only under %s, even with a restrictive allowlist", async mode => {
		for (const method of ["GET", "HEAD"]) {
			const confirm = vi.fn(async () => false);
			await workflow(method, mode, confirm, ["read_file"]);
			expect(confirm).not.toHaveBeenCalled();
		}
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it("workflow hard restrictions cannot be overridden by a consenting host", async () => {
		const confirm = vi.fn(async () => true);
		await workflow("POST", "auto-accept", confirm, ["read_file"]);
		expect(confirm).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});
	it("workflow missing callback fails closed even for a direct invoker caller", async () => {
		await createDefaultAgentInvoker({ provider: scripted("POST"), config: config("auto-accept") }).invoke({
			agent: agent(), task: "fetch", signal: new AbortController().signal, cwd: dir,
			confirmTool: undefined as unknown as AgentInvokeRequest["confirmTool"],
		});
		expect(transport).not.toHaveBeenCalled();
	});
	it("workflow host receives exact mutation input and agent-tool consent context", async () => {
		const confirm = vi.fn(async () => true);
		const input = { url, method: "POST", body: "payload" };
		const signal = new AbortController().signal;
		await expect(confirmAgentTool("fetch_url", input, config("auto-accept"), signal, { confirmTool: confirm }, { nodeId: "n" })).resolves.toBe(true);
		expect(confirm).toHaveBeenCalledWith("fetch_url", input, signal, { nodeId: "n", kind: "agent_tool_consent" });
	});
	it("workflow verdict cannot turn a blanket fetch allowlist into mutation consent", () => {
		for (const permissionMode of ["ask", "auto-accept"] as const) {
			expect(agentToolVerdict("fetch_url", { url, method: "POST" }, { ...config(permissionMode), allowedTools: ["fetch_url"] })).toBe("ask");
		}
	});
	it("a mutation obeys the hard tool restriction even with a permissive callback", async () => {
		const confirm = vi.fn(async (): Promise<ConfirmResult> => "yes");
		expect(await loop("POST", { allowedTools: ["read_file"], confirmTool: confirm })).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
	});
	it("neither destructive:false nor a pattern allowlist bypasses mutation consent", async () => {
		const confirm = vi.fn(async (): Promise<ConfirmResult> => "no");
		expect(await loop("POST", { allowedTools: ["fetch_url:*"], confirmTool: confirm })).not.toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledOnce();
	});
	it("blanket Always is not an explicit approval of a mutation", async () => {
		expect(await loop("POST", { confirmTool: async () => "always" })).not.toHaveBeenCalled();
	});
});

describe("HTTP permission classification", () => {
	it.each([undefined, null, "GET", "get", "HEAD", "head"])("classifies %s as a read", method => {
		expect(isReadOnlyHttpMethod(method)).toBe(true);
	});
	it.each(["POST", "post", "PUT", "DELETE", "PATCH", "OPTIONS", "", " GET ", "HEAD\r\n", 0, false, {}])("fails closed for %s", method => {
		expect(isReadOnlyHttpMethod(method)).toBe(false);
		expect(agentToolVerdict("fetch_url", { method }, config("auto-accept"))).toBe("ask");
	});
	it("normalizes case without treating invalid token whitespace as read-only", () => {
		expect(normalizeHttpMethod(" get ")).toBe(" GET ");
		expect(normalizeHttpMethod("patch")).toBe("PATCH");
		expect(normalizeHttpMethod(undefined)).toBe("GET");
	});
});

describe("confirmation queue fetch boundary", () => {
	it("prior generic Always cannot auto-resolve a later mutating fetch", async () => {
		const queue = new ConfirmationQueue();
		let shown: QueuedConfirmation | null = null;
		queue.bind(item => { shown = item; });
		const blanket = queue.enqueue({ toolName: "write_file", input: {} });
		queue.resolve("always");
		await expect(blanket).resolves.toBe("always");
		const mutation = queue.enqueue({ toolName: "fetch_url", input: { url, method: "POST" } });
		expect(shown).toMatchObject({ toolName: "fetch_url", explicitApprovalOnly: true });
		queue.resolve("yes");
		await expect(mutation).resolves.toBe("yes");
	});
	it("generic Always cannot drain a queued mutating fetch; fetch Always fails closed", async () => {
		const queue = new ConfirmationQueue();
		let shown: QueuedConfirmation | null = null;
		queue.bind(item => { shown = item; });
		const blanket = queue.enqueue({ toolName: "write_file", input: {} });
		const mutation = queue.enqueue({ toolName: "fetch_url", input: { url, method: "PATCH" } });
		queue.resolve("always");
		await expect(blanket).resolves.toBe("always");
		expect(shown).toMatchObject({ toolName: "fetch_url", explicitApprovalOnly: true });
		expect(queue.resolve("always")).toBe("no");
		await expect(mutation).resolves.toBe("no");
	});
});
