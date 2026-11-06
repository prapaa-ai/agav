import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runWorkflowsCli } from "../cli/workflows-cli.js";
import { resumeWorkflowRun, startWorkflowRun } from "../resources/workflow-adapters.js";
import { prepareLaunch, startBackgroundRun } from "../workflows/background.js";
import { buildConsent } from "../workflows/grant.js";
import { launchRun, updateRun } from "../workflows/launch.js";
import { admitQueuedRuns } from "../workflows/reconcile.js";
import { startRunner } from "../workflows/runner.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { getSandboxNetwork, setSandboxNetwork, setSandboxRequired } from "../utils/sandbox.js";
import { def, fakeHost, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => {
	setSandboxNetwork("deny");
	setSandboxRequired(false);
	({ store, cleanup } = await tempStore());
});
afterEach(async () => {
	vi.restoreAllMocks();
	setSandboxNetwork("deny");
	setSandboxRequired(false);
	await cleanup();
});
const definition = def([{ id: "a", type: "job", command: "echo hi" }]);
const CLI = "/opt/agav/build/cli.js";
async function consented(extra: Partial<WorkflowRun> = {}) {
	const run = await createRun(store, definition, {}, { host: "background" });
	run.consent = buildConsent(definition, run.cwd, "auto-accept", []);
	Object.assign(run, extra);
	await store.lock(run.id, () => store.save(run));
	return run;
}
const launch = (sandboxNetwork?: "allow" | "deny", coordinator = new FakeCoordinator()) => ({ coordinator, cliPath: CLI, registry, sandboxNetwork });

describe("workflow network policy persistence", () => {
	it.each(["allow", "deny"] as const)("captures the parent's effective %s policy before detaching", async policy => {
		setSandboxNetwork(policy);
		const prepared = await prepareLaunch(definition, {}, "test", testConfig(), []);
		const result = await startBackgroundRun(store, prepared, "auto-accept", [], launch());
		expect(result.run.sandboxNetwork).toBe(policy);
		expect((await store.read(result.run.id, registry)).sandboxNetwork).toBe(policy);
	});

	it.each(["allow", "deny"] as const)("captures an explicit %s policy even if process state differs", async policy => {
		setSandboxNetwork(policy === "allow" ? "deny" : "allow");
		const prepared = await prepareLaunch(definition, {}, "test", testConfig(), []);
		const result = await startBackgroundRun(store, prepared, "auto-accept", [], launch(policy));
		expect(result.run.sandboxNetwork).toBe(policy);
	});

	it.each([null, true, "invalid", {}])("rejects invalid stored network policy %j", async sandboxNetwork => {
		const run = await consented();
		const path = `${store.root}/${run.id}.json`;
		await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), sandboxNetwork }));
		await expect(store.read(run.id, registry)).rejects.toThrow(/Invalid workflow checkpoint/);
	});

	it("tightens an attached run and never weakens it on another relaunch", async () => {
		const run = await consented({ sandboxNetwork: "allow" });
		const coordinator = new FakeCoordinator();
		await launchRun(store, run.id, launch("allow", coordinator));
		expect((await launchRun(store, run.id, launch("deny", coordinator))).status).toBe("attached");
		expect((await store.read(run.id, registry)).sandboxNetwork).toBe("deny");
		await launchRun(store, run.id, launch("allow", coordinator));
		expect((await store.read(run.id, registry)).sandboxNetwork).toBe("deny");
		expect(coordinator.starts).toHaveLength(1);
	});

	it("fails closed if tightening an attached run cannot be persisted", async () => {
		const run = await consented({ sandboxNetwork: "allow" });
		const coordinator = new FakeCoordinator();
		await launchRun(store, run.id, launch("allow", coordinator));
		vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));
		await expect(launchRun(store, run.id, launch("deny", coordinator))).rejects.toThrow("disk full");
		expect(coordinator.starts).toHaveLength(1);
	});

	it("persists deny even when a missing environment defers an interrupted run", async () => {
		const run = await consented({ sandboxNetwork: "allow", status: "interrupted" });
		await updateRun(store, run.id, registry, current => { current.consent!.envNames = ["TOKEN"]; });
		await expect(launchRun(store, run.id, { ...launch("deny"), admissionEnv: {} })).rejects.toThrow(/not launched/);
		expect((await store.read(run.id, registry)).sandboxNetwork).toBe("deny");
	});

	it("does not leak an exiting runner's policy into another queued run", async () => {
		setSandboxNetwork("deny");
		const run = await consented({ sandboxNetwork: "allow", status: "queued" });
		await updateRun(store, run.id, registry, current => { current.runner = { attempt: 1, requestId: `wf-run-${run.id}-1`, relaunches: 0 }; });
		await admitQueuedRuns(store, launch());
		expect((await store.read(run.id, registry)).sandboxNetwork).toBe("allow");
	});
});

describe("detached runner network restoration", () => {
	it.each([
		["deny", "allow", "deny"],
		["allow", "deny", "allow"],
		[undefined, "allow", "allow"],
		[undefined, undefined, "allow"],
		[undefined, "deny", "deny"],
	] as const)("stored %s with disk %s executes under %s", async (stored, disk, expected) => {
		const run = await consented(stored ? { sandboxNetwork: stored } : {});
		setSandboxNetwork(expected === "allow" ? "deny" : "allow");
		const coordinator = new FakeCoordinator();
		const originalStart = coordinator.start.bind(coordinator);
		vi.spyOn(coordinator, "start").mockImplementation(async request => {
			expect(getSandboxNetwork()).toBe(expected);
			expect((await store.read(run.id, registry)).sandboxNetwork).toBe(expected);
			return originalStart(request);
		});
		const done = await startRunner(run.id, { store, registry, config: testConfig({ sandboxNetwork: disk }), getCoordinator: async () => coordinator, jobDepsOverrides: { pollIntervalMs: 5 } }).done;
		expect(done.status).toBe("passed");
		expect(done.sandboxNetwork).toBe(expected);
		expect(coordinator.starts).toHaveLength(1);
	});

	it("starts nothing if a legacy policy cannot be persisted", async () => {
		const run = await consented();
		const coordinator = new FakeCoordinator();
		vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));
		await expect(startRunner(run.id, { store, registry, config: testConfig(), getCoordinator: async () => coordinator }).done).rejects.toThrow("disk full");
		expect(coordinator.starts).toHaveLength(0);
	});
});

describe("CLI policy propagation", () => {
	it.each(["allow", "deny"] as const)("initial run captures the effective %s config instead of stale process policy", async sandboxNetwork => {
		setSandboxNetwork(sandboxNetwork === "allow" ? "deny" : "allow");
		const path = join(store.root, "..", "workflow.json");
		await writeFile(path, JSON.stringify(definition));
		const stdin = Object.assign(new PassThrough(), { isTTY: true });
		const stdout = Object.assign(new PassThrough(), { isTTY: true });
		stdin.end("y\n");
		stdout.resume();
		const coordinator = new FakeCoordinator();
		expect(await runWorkflowsCli(["run", path], { config: testConfig({ sandboxNetwork }), store, stdin, stdout, env: {}, getCoordinator: async () => coordinator, cliPath: CLI })).toBe(0);
		const [id] = await store.listIds();
		expect((await store.read(id!, registry)).sandboxNetwork).toBe(sandboxNetwork);
		expect(coordinator.starts).toHaveLength(1);
	});
	it.each(["resume", "status"])("%s passes the effective invocation deny policy into relaunch", async command => {
		const run = await consented({ sandboxNetwork: "allow", status: "queued" });
		await updateRun(store, run.id, registry, current => { current.runner = { attempt: 1, requestId: `wf-run-${run.id}-1`, relaunches: 0 }; });
		const coordinator = new FakeCoordinator();
		const stdout = Object.assign(new PassThrough(), { isTTY: false });
		expect(await runWorkflowsCli([command, run.id], { config: testConfig({ sandboxNetwork: "deny" }), store, stdout, getCoordinator: async () => coordinator, cliPath: CLI })).toBe(0);
		expect((await store.read(run.id, registry)).sandboxNetwork).toBe("deny");
		expect(coordinator.starts).toHaveLength(1);
	});
});


describe("foreground execution network policy", () => {
	it.each(["allow", "deny"] as const)("captures and enforces %s before a tool runs", async policy => {
		const run = await createRun(store, def([{ id: "a", type: "tool", tool: "read_file", input: { path: "x" } }]), {}, { host: "foreground" });
		const host = fakeHost({ read_file: () => {
			expect(getSandboxNetwork()).toBe(policy);
			return { output: "ok", isError: false };
		} });
		const done = await executeRun(store, run.id, registry, testConfig({ sandboxNetwork: policy }), undefined, host);
		expect(done.status).toBe("passed");
		expect(done.sandboxNetwork).toBe(policy);
	});

	it("tightens a foreground resume and keeps deny sticky", async () => {
		const run = await createRun(store, def([{ id: "gate", type: "approval", prompt: "?" }]), {});
		await executeRun(store, run.id, registry, testConfig({ sandboxNetwork: "allow" }), undefined, fakeHost());
		expect((await store.read(run.id, registry)).sandboxNetwork).toBe("allow");
		await executeRun(store, run.id, registry, testConfig({ sandboxNetwork: "deny" }), undefined, fakeHost());
		await executeRun(store, run.id, registry, testConfig({ sandboxNetwork: "allow" }), undefined, fakeHost());
		expect((await store.read(run.id, registry)).sandboxNetwork).toBe("deny");
		expect(getSandboxNetwork()).toBe("deny");
	});
});

describe("TUI network policy propagation", () => {
	it.each(["allow", "deny"] as const)("captures %s from effective config, not stale process state", async sandboxNetwork => {
		setSandboxNetwork(sandboxNetwork === "allow" ? "deny" : "allow");
		const config = testConfig({ sandboxNetwork });
		const coordinator = new FakeCoordinator();
		const deps = { store, registry, cwd: process.cwd(), config, getCoordinator: async () => coordinator, cliPath: async () => CLI };
		const prepared = await prepareLaunch(definition, {}, "test", config, []);
		const result = await startWorkflowRun(deps, prepared, []);
		expect((await store.read(result.runId, registry)).sandboxNetwork).toBe(sandboxNetwork);
	});
	it("tightens policy when resuming from the TUI", async () => {
		const run = await consented({ sandboxNetwork: "allow" });
		const coordinator = new FakeCoordinator();
		await resumeWorkflowRun({ store, registry, cwd: process.cwd(), config: testConfig({ sandboxNetwork: "deny" }), getCoordinator: async () => coordinator, cliPath: async () => CLI }, run.id);
		expect((await store.read(run.id, registry)).sandboxNetwork).toBe("deny");
	});
});
