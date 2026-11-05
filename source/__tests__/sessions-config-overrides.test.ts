import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const channel = "AGAV_SESSION_CONFIG_OVERRIDES";
const mocks = vi.hoisted(() => ({ root: "", provider: vi.fn(), start: vi.fn(), org: {} }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => mocks.root }));
vi.mock("../config/org-config.js", async original => ({ ...await original<typeof import("../config/org-config.js")>(), loadOrgPolicy: async () => mocks.org }));
vi.mock("../utils/temp-output.js", () => ({ tempOutputManager: { pruneStale: vi.fn() } }));
vi.mock("../providers/registry.js", () => ({ createProvider: mocks.provider }));
vi.mock("../background-jobs-integration.js", () => ({ getSharedCoordinator: async () => ({ start: mocks.start, findByRequestId: async () => undefined }) }));
let cwd: string;
beforeEach(async () => {
	vi.resetModules(); vi.clearAllMocks(); mocks.org = {};
	cwd = process.cwd(); mocks.root = await mkdtemp(join(tmpdir(), "agav-worker-config-"));
	process.chdir(mocks.root);
	await mkdir(join(mocks.root, ".agav"));
	for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "AGAV_HOME", "AGAV_ORG_CONFIG", channel]) vi.stubEnv(key, undefined);
	mocks.start.mockImplementation(async request => ({ jobId: "test-job", requestId: request.requestId, state: "running", stopState: "none" }));
	mocks.provider.mockImplementation(() => { throw new Error("provider captured"); });
});
afterEach(async () => { process.chdir(cwd); vi.unstubAllEnvs(); await rm(mocks.root, { recursive: true, force: true }); });
async function setup(entries: string[], saved: Record<string, unknown> = {}, dedicated: Record<string, unknown> = {}) {
	await writeFile(join(mocks.root, ".agav", "config.json"), JSON.stringify({ provider: "anthropic", model: "mock", permissionMode: "ask", backgroundJobsEnabled: true, anthropicApiKey: "stored-account", ...saved }));
	const configModule = await import("../config/config.js");
	const { parseConfigOverride, applyConfigOverrides } = await import("../config/cli-overrides.js");
	const parsed = entries.map(parseConfigOverride);
	configModule.setSessionConfigOverrides({ entries: parsed, apply: config => applyConfigOverrides(config, parsed) });
	const config = Object.assign(await configModule.loadConfig(), dedicated);
	const { ConversationState } = await import("../agent/conversation.js");
	const conversation = new ConversationState(); conversation.addUserMessage("hello");
	const { startInteractiveSessionWorker } = await import("../sessions/interactive.js");
	const record = await startInteractiveSessionWorker(config, conversation, { permissionMode: "ask", iterationsBudget: { total: 2, remaining: 2 }, signal: new AbortController().signal });
	expect(mocks.start).toHaveBeenCalledOnce();
	// Reexecute with only the private host environment, not the parent's module state.
	expect(process.env[channel]).toBeUndefined();
	const [request, policy] = mocks.start.mock.calls[0]!;
	configModule.setSessionConfigOverrides(undefined);
	if (policy.inheritedEnv?.[channel] !== undefined) {
		expect(request.envInherit).toContain(channel);
		vi.stubEnv(channel, policy.inheritedEnv[channel]);
	}
	return { config, record, request, configModule, run: (await import("../sessions/runner.js")).runSessionRunner };
}
it.each([
	{ entries: [], expected: { anthropicApiKey: "stored-account", backgroundJobsEnabled: true } },
	{ entries: ["providerIdleTimeout=200"], dedicated: { providerIdleTimeout: undefined }, expected: { providerIdleTimeout: undefined } },
	{ entries: ["openaiHeaders.x-session=secret-header"], saved: { openaiHeaders: { "x-stored": "retained" } }, expected: { openaiHeaders: { "x-session": "secret-header", "x-stored": "retained" } } },
	{ entries: ["ollamaApiKey=override-key"], saved: { provider: "ollama", ollamaApiKey: "stored-key" }, dedicated: { ollamaApiKey: "dedicated-key" }, expected: { ollamaApiKey: "dedicated-key" } },
	{ entries: ["anthropicApiKey=session-account"], expected: { anthropicApiKey: "session-account" } },
	{ entries: ["backgroundJobsEnabled=true"], saved: { backgroundJobsEnabled: false }, expected: { backgroundJobsEnabled: true } },
	{ entries: ["openaiBaseURL=https://session.example/v1"], saved: { provider: "openai", openaiApiKey: "test", openaiBaseURL: "https://saved.example/v1" }, expected: { openaiBaseURL: "https://session.example/v1" } },
	{ entries: ["errorRetries=0", 'mcpServers={"temporary":{"command":"echo"}}'], expected: { errorRetries: 0, mcpServers: { temporary: { command: "echo" } } } },
	{ entries: ["ollamaHost=session", "ollamaPort=12345"], saved: { provider: "ollama" }, expected: { ollamaHost: "session", ollamaPort: 12345 } },
	{ entries: ["openaiBaseURL=https://override.example/v1"], saved: { provider: "openai", openaiApiKey: "test" }, dedicated: { openaiBaseURL: "https://dedicated.example/v1" }, expected: { openaiBaseURL: "https://dedicated.example/v1" } },
])("restores $entries before the worker loads config", async ({ entries, saved, dedicated, expected }) => {
	const { record, request, run, configModule } = await setup(entries, saved, dedicated);
	await expect(run(record.id, record.generation)).rejects.toThrow("provider captured");
	expect(mocks.provider).toHaveBeenCalledWith(expect.objectContaining(expected));
	expect(await configModule.loadConfig()).toMatchObject(expected);
	expect(process.env[channel]).toBeUndefined();
	expect(JSON.stringify(request)).not.toContain("session-account");
	expect(JSON.stringify(request)).not.toContain("secret-header");
	const { SessionRuntimeStore } = await import("../sessions/store.js");
	expect(await readFile(join(new SessionRuntimeStore().directory(record.id), "runtime.json"), "utf8")).not.toContain("session-account");
});
it("reapplies fresh organization policy above the transferred overlay", async () => {
	const { record, run } = await setup(["permissionMode=auto-accept"]);
	mocks.org = { config: { permissionMode: "deny-writes" } };
	await expect(run(record.id, record.generation)).rejects.toThrow("provider captured");
	expect(mocks.provider).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "deny-writes" }));
});
it.each(["malformed", "generation", "policy", "prototype"])("fails closed on %s private payload without echoing secrets", async kind => {
	const { record, run } = await setup(["anthropicApiKey=session-account"]);
	const payload = JSON.parse(process.env[channel]!);
	if (kind === "generation") payload.generation = "other-generation";
	else if (kind === "policy") payload.entries = [{ path: ["orgPermissionFloor"], value: "auto-accept" }];
	else if (kind === "prototype") payload.entries = [{ path: ["__proto__"], value: {} }];
	vi.stubEnv(channel, kind === "malformed" ? '{"secret":"must-not-be-logged"}' : JSON.stringify(payload));
	await expect(run(record.id, record.generation)).rejects.toThrow("Invalid session config overrides");
	expect(mocks.provider).not.toHaveBeenCalled();
	expect(process.env[channel]).toBeUndefined();
});

it("does not transfer or accept unrelated transient credential changes", async () => {
	await expect(setup([], {}, { anthropicApiKey: "unregistered-secret" })).rejects.toThrow("cannot reload this transient credential override");
	expect(mocks.start).not.toHaveBeenCalled();
});

it("transfers session config across a real process boundary without sharing module state", async () => {
	const { record } = await setup(["anthropicApiKey=session-account", "backgroundJobsEnabled=true", "errorRetries=0"], { backgroundJobsEnabled: false });
	const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"),
		fileURLToPath(new URL("./helpers/session-config-worker.ts", import.meta.url)), record.id, record.generation], {
		cwd: mocks.root, timeout: 10_000,
		env: { HOME: mocks.root, USERPROFILE: mocks.root, [channel]: process.env[channel],
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
	});
	expect(stderr).toBe("");
	expect(JSON.parse(stdout)).toEqual({ credentialMatches: true, backgroundJobsEnabled: true, errorRetries: 0, channelConsumed: true });
});
