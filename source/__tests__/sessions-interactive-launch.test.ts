import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { SessionPolicySnapshot, StartJobRequest } from "../background-jobs/types.js";
import { BackgroundJobError } from "../background-jobs/types.js";
import { ConversationState } from "../agent/conversation.js";
import { createAuthorizationService } from "../background-jobs/authorization/service.js";
import { normalizeLaunchSpec } from "../background-jobs/launch-spec/normalize.js";
import { getPlatformAdapter } from "../background-jobs/platform/index.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "../sessions/store.js";

const mocks = vi.hoisted(() => ({ root: "", config: {} as AgavConfig, coordinator: vi.fn(), create: vi.fn() }));
vi.mock("../config/config.js", async original => ({ ...await original<typeof import("../config/config.js")>(),
  getAgavDir: () => mocks.root, loadConfig: async () => mocks.config }));
vi.mock("../background-jobs-integration.js", () => ({ getSharedCoordinator: mocks.coordinator }));
vi.mock("../sessions/runner.js", () => ({ createSessionExecution: mocks.create }));
import { startInteractiveSessionWorker, sessionWorkerEnvironmentNames } from "../sessions/interactive.js";

let root: string;
let store: SessionRuntimeStore;
let published: SessionRuntimeRecord | undefined;
let config: AgavConfig & { detachedSessionsEnabled?: boolean };
const start = vi.fn();
const lookup = vi.fn(async () => undefined);
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), "agav-interactive-owner-"));
  mocks.root = root;
  store = new SessionRuntimeStore();
  published = undefined;
  config = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000,
    maxIterations: 2, errorRetries: 1, permissionMode: "ask", backgroundJobsEnabled: true, detachedSessionsEnabled: true };
  mocks.config = config;
  mocks.create.mockImplementation(async (target: SessionRuntimeStore) => target.create({ cwd: root,
    provider: "anthropic", model: "mock", permissionMode: "ask", sandboxRequired: false }));
  mocks.coordinator.mockResolvedValue({ start, findByRequestId: lookup });
  lookup.mockResolvedValue(undefined);
  start.mockImplementation(async (request: StartJobRequest, session: SessionPolicySnapshot) => {
    const adapter = await getPlatformAdapter();
    const capabilities = await adapter.detectCapabilities();
    const spec = await normalizeLaunchSpec({ ...request, platform: adapter.platform,
      ownershipScope: capabilities.strongestOwnershipScope, canonicalizeCwd: path => adapter.canonicalizePath(path) });
    const decision = await createAuthorizationService(root).authorize("start", spec, session, { headless: request.headless });
    if (!decision.allowed) throw new BackgroundJobError("authorization-denied", decision.reason);
    return { requestId: request.requestId, jobId: "owner-job", state: "running", stopState: "none" };
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

function launch(signal = new AbortController().signal) {
  return startInteractiveSessionWorker(config, new ConversationState(), { permissionMode: "ask", iterationsBudget: { remaining: 2, total: 2 },
    signal, onCreated: record => { published = record; } });
}

describe("interactive owner launch consent and private environment", () => {
  it("requires dedicated detached-session opt-in, not merely background-jobs enablement", async () => {
    delete config.detachedSessionsEnabled;
    await expect(launch()).rejects.toThrow(/detachedSessionsEnabled=true/);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["ask", "auto-accept"] as const)("uses exact ask consent even under %s, without a blanket action grant", async mode => {
    config.permissionMode = mode;
    await launch();
    expect(start).toHaveBeenCalledTimes(1);
    const [request, policy] = start.mock.calls[0] as [StartJobRequest, SessionPolicySnapshot];
    expect(request.headless).toBe(false); // a detached process is not headless consent
    expect(policy.permissionMode).toBe("ask");
    expect(policy.headlessApprovedActions).toEqual([]);
    const adapter = await getPlatformAdapter();
    const capabilities = await adapter.detectCapabilities();
    const expected = await normalizeLaunchSpec({ ...request, platform: adapter.platform,
      ownershipScope: capabilities.strongestOwnershipScope, canonicalizeCwd: path => adapter.canonicalizePath(path) });
    const confirm = policy.confirmBackgroundAction!;
    expect(await confirm("start", expected)).toBe(true);
    expect(await confirm("stop", expected)).toBe(false);
    expect(await confirm("start", { ...expected, invocation: { mode: "direct", executable: "/bin/sh", args: [] } })).toBe(false);
    expect(await confirm("start", { ...expected, cwd: "/tmp" })).toBe(false);
    expect(await confirm("start", { ...expected, envInherit: ["UNRELATED_SECRET"] })).toBe(false);
    expect(await confirm("start", { ...expected, limits: { ...expected.limits, maxConcurrentJobs: 999 } })).toBe(false);
    expect(await confirm("start", { ...expected, headless: true })).toBe(false);
    const controller = new AbortController();
    await launch(controller.signal);
    controller.abort();
    expect(await start.mock.calls[1]![1].confirmBackgroundAction("start", expected)).toBe(false);
  });

  it.each(["caller", "organization"] as const)("does not weaken %s deny-writes", async origin => {
    if (origin === "caller") config.permissionMode = "deny-writes";
    else config.orgPermissionFloor = "deny-writes";
    await expect(launch()).rejects.toMatchObject({ admission: "not-admitted", record: { status: "failed" } });
    expect(start.mock.calls[0]![1].permissionMode).toBe("deny-writes");
    expect((await store.read(published!.id))?.status).toBe("failed");
  });

  it("marks coordinator initialization failure terminal after publishing ownership", async () => {
    mocks.coordinator.mockRejectedValueOnce(new Error("coordinator initialization failed"));
    await expect(launch()).rejects.toMatchObject({ admission: "not-admitted", record: { status: "failed" } });
    expect(published).toBeDefined();
    expect((await store.read(published!.id))?.status).toBe("failed");
    expect(start).not.toHaveBeenCalled();
  });

  it("marks cancellation after creation terminal before coordinator admission", async () => {
    const controller = new AbortController();
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementationOnce(async (...args) => { const record = await create(...args); controller.abort(); return record; });
    await expect(launch(controller.signal)).rejects.toMatchObject({ admission: "not-admitted", record: { status: "failed" } });
    expect((await store.read(published!.id))?.status).toBe("failed");
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves unknown admission as ownership barrier rather than claiming failure", async () => {
    start.mockRejectedValueOnce(new Error("response lost"));
    await expect(launch()).rejects.toMatchObject({ admission: "unknown", record: { status: "starting" } });
    expect((await store.read(published!.id))?.status).toBe("starting");
  });

  it("forwards SDK routing, proxy and trust settings by name only", async () => {
    const names = ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
      "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_ENV_PROXY", "NODE_USE_SYSTEM_CA"];
    for (const name of names) vi.stubEnv(name, `private-value-${name}`);
    vi.stubEnv("UNRELATED_SECRET", "must-not-be-inherited");
    expect(sessionWorkerEnvironmentNames()).toEqual(expect.arrayContaining(names));
    expect(sessionWorkerEnvironmentNames()).not.toContain("UNRELATED_SECRET");
    await launch();
    const request = start.mock.calls[0]![0] as StartJobRequest;
    expect(request.envInherit).toEqual(expect.arrayContaining(names));
    expect(request.env).toBeUndefined();
    const descriptor = JSON.stringify(request) + await readFile(join(store.directory(published!.id), "runtime.json"), "utf8");
    for (const name of names) expect(descriptor).not.toContain(`private-value-${name}`);
    expect(descriptor).not.toContain("must-not-be-inherited");
  });
});
