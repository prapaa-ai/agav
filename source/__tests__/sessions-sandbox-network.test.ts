import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgavConfig } from "../config/config.js";
import { ConversationState } from "../agent/conversation.js";
import { createSessionExecution, sessionExecutionConfig } from "../sessions/runner.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import * as sandbox from "../utils/sandbox.js";

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 128,
	maxIterations: 3, errorRetries: 0, permissionMode: "ask" };
let root: string;
let store: SessionRuntimeStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "agav-session-network-"));
	store = new SessionRuntimeStore(root);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});
const create = (sandboxNetwork?: AgavConfig["sandboxNetwork"]) =>
	createSessionExecution(store, { ...config, sandboxNetwork }, { conversation: new ConversationState() });

it.each([
	{ selected: "deny", other: "allow" },
	{ selected: "allow", other: "deny" },
] as const)("persists explicit $selected over global and worker-local $other", async ({ selected, other }) => {
	const global = vi.spyOn(sandbox, "getSandboxNetwork").mockReturnValue(other);
	const record = await create(selected);
	expect(record.sandboxNetwork).toBe(selected);
	const stored = (await new SessionRuntimeStore(root).read(record.id))!;
	expect(stored.sandboxNetwork).toBe(selected);
	expect(sessionExecutionConfig(stored, { ...config, sandboxNetwork: other }).sandboxNetwork).toBe(selected);
	expect(global).not.toHaveBeenCalled();
});

it.each(["allow", "deny"] as const)("captures global %s only when the parent config has no policy", async policy => {
	vi.spyOn(sandbox, "getSandboxNetwork").mockReturnValue(policy);
	expect((await create()).sandboxNetwork).toBe(policy);
});

it.each([
	{ local: "allow", expected: "allow" },
	{ local: "deny", expected: "deny" },
	{ local: undefined, expected: "deny" },
] as const)("restores a legacy record from local $local, not the global policy", async ({ local, expected }) => {
	const record = await create("deny");
	delete record.sandboxNetwork;
	await writeFile(join(store.directory(record.id), "runtime.json"), JSON.stringify(record));
	const global = vi.spyOn(sandbox, "getSandboxNetwork").mockReturnValue("allow");
	const legacy = (await store.read(record.id))!;
	expect(legacy.sandboxNetwork).toBeUndefined();
	expect(sessionExecutionConfig(legacy, { ...config, sandboxNetwork: local }).sandboxNetwork).toBe(expected);
	expect(global).not.toHaveBeenCalled();
});

it.each(["invalid", "ALLOW", "", null, true, 1, {}, ["allow"]].map(policy => ({ policy })))("rejects invalid stored network policy $policy rather than falling back to allow", async ({ policy }) => {
	const record = await create("deny");
	const path = join(store.directory(record.id), "runtime.json");
	const invalid = { ...record, sandboxNetwork: policy } as unknown as typeof record;
	await expect(store.save(invalid)).rejects.toThrow(/Corrupt session runtime/);
	expect(JSON.parse(await readFile(path, "utf8")).sandboxNetwork).toBe("deny");
	await writeFile(path, JSON.stringify(invalid));
	await expect(store.read(record.id)).rejects.toThrow(/Corrupt session runtime/);
	expect(await store.list()).toEqual([]);
});
