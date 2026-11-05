/**
 * Inherited env VALUES are secrets: only their NAMES may be persisted under the background-jobs root.
 * The coordinator hands the values to the supervisor through its process environment
 * (INHERITED_ENV_VAR), and the supervisor resolves them into the workload env at spawn time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const captured = vi.hoisted(() => ({ launches: [] as Array<{ inheritedEnv?: Record<string, string> }> }));
vi.mock("../coordinator/launcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../coordinator/launcher.js")>();
  return {
    ...original,
    launchSupervisorForJob: vi.fn(async (args: { jobId: string; inheritedEnv?: Record<string, string>; repositories: import("../types.js").Repositories }) => {
      captured.launches.push({ inheritedEnv: args.inheritedEnv });
      await args.repositories.jobs.update(args.jobId, { state: "running", startedAt: new Date().toISOString() });
      return { identity: { pid: 0, creationIdentity: "unavailable" }, ownershipHandle: "fake", ownershipScope: "unverified" as const };
    }),
  };
});

import { createCoordinator } from "../coordinator/service.js";
import { INHERITED_ENV_VAR } from "../launch-spec/environment.js";
import { createFileRepositories } from "../storage/repositories.js";
import { resolveStorageRoot } from "../storage/paths.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { JobSupervisor, takeInheritedEnvironment, workloadEnvironment } from "../supervisor/lifecycle.js";
import { DEFAULT_RESOURCE_LIMITS, type LaunchSpec, type SessionPolicySnapshot } from "../types.js";

const SECRET_NAME = "AGAV_TEST_INHERITED_SECRET";
const SECRET_VALUE = `s3cr3t-${randomUUID()}`;

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-secret-env-"));
  process.env[SECRET_NAME] = SECRET_VALUE;
  captured.launches.length = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env[SECRET_NAME];
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("inherited env values are never persisted", () => {
  it("a start with envInherit writes only the name to disk and passes the value to the supervisor launch", async () => {
    const coordinator = await createCoordinator({ root: base });
    const requestId = randomUUID();
    await coordinator.start({
      requestId,
      invocation: { mode: "direct", executable: process.execPath, args: ["-e", ""] },
      cwd: base,
      envInherit: [SECRET_NAME],
      isolation: { backend: "none", required: false },
    }, { permissionMode: "auto-accept", headlessApprovedActions: [] });

    const files = await filesUnder(coordinator.root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(await readFile(file, "utf8"), file).not.toContain(SECRET_VALUE);

    const spec = await coordinator.repositories.specs.get(requestId);
    expect(spec!.envInherit).toEqual([SECRET_NAME]);
    expect(spec!.env[SECRET_NAME]).toBeUndefined();
    expect(captured.launches).toEqual([{ inheritedEnv: { [SECRET_NAME]: SECRET_VALUE } }]);
  });

  it("uses only consented host values privately, overriding process env without mutating it", async () => {
    const coordinator = await createCoordinator({ root: base });
    const hostSecret = `host-${randomUUID()}`;
    const unselectedSecret = `unselected-${randomUUID()}`;
    vi.stubEnv("AGAV_HOST_ONLY", undefined);
    vi.stubEnv("AGAV_HOST_EMPTY", "parent-nonempty");
    const inheritedEnv = Object.freeze({ [SECRET_NAME]: hostSecret, AGAV_HOST_ONLY: "host-only-value",
      AGAV_HOST_EMPTY: "", AGAV_UNSELECTED: unselectedSecret });
    const confirmBackgroundAction = vi.fn(async () => true);
    const session: SessionPolicySnapshot = { permissionMode: "ask", headlessApprovedActions: [], inheritedEnv, confirmBackgroundAction };
    const request = {
      requestId: randomUUID(),
      invocation: { mode: "direct" as const, executable: process.execPath, args: ["-e", ""] },
      cwd: base, envInherit: [SECRET_NAME, "AGAV_HOST_ONLY", "AGAV_HOST_EMPTY"],
      isolation: { backend: "none" as const, required: false },
    };
    const beforeEnv = { ...process.env };
    const beforeRequest = structuredClone(request);
    const first = await coordinator.start(request, session);
    expect(captured.launches).toEqual([{ inheritedEnv: { [SECRET_NAME]: hostSecret, AGAV_HOST_ONLY: "host-only-value", AGAV_HOST_EMPTY: "" } }]);
    expect(process.env).toEqual(beforeEnv);
    expect(request).toEqual(beforeRequest);
    expect(session.inheritedEnv).toBe(inheritedEnv);
    const spec = await coordinator.repositories.specs.get(request.requestId);
    expect(spec!.envInherit).toEqual([...request.envInherit].sort());
    for (const name of request.envInherit) expect(spec!.env).not.toHaveProperty(name);
    expect(confirmBackgroundAction).toHaveBeenCalledTimes(1);
    for (const secret of [hostSecret, unselectedSecret, "host-only-value"]) {
      expect(JSON.stringify(request)).not.toContain(secret);
      expect(JSON.stringify(confirmBackgroundAction.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(first)).not.toContain(secret);
      for (const file of await filesUnder(coordinator.root)) expect(await readFile(file, "utf8"), file).not.toContain(secret);
    }
    // Values are not consent metadata and must not force a relaunch on retry.
    expect((await coordinator.start(request, { ...session, inheritedEnv: { [SECRET_NAME]: "rotated-host-value" } })).jobId).toBe(first.jobId);
    expect(captured.launches).toHaveLength(1);
  });

  it("ignores prototype values and falls back to process env for names without own host values", async () => {
    const coordinator = await createCoordinator({ root: base });
    vi.stubEnv("AGAV_HOST_PROTOTYPE_ONLY", undefined);
    const inheritedEnv = Object.freeze(Object.create({ [SECRET_NAME]: "prototype-secret", AGAV_HOST_PROTOTYPE_ONLY: "prototype-only" })) as Readonly<Record<string, string>>;
    const session: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [], inheritedEnv };
    const request = { requestId: randomUUID(), invocation: { mode: "direct" as const, executable: process.execPath, args: [] },
      cwd: base, envInherit: [SECRET_NAME, "AGAV_HOST_PROTOTYPE_ONLY"], isolation: { backend: "none" as const, required: false } };
    await coordinator.start(request, session);
    expect(captured.launches).toEqual([{ inheritedEnv: { [SECRET_NAME]: SECRET_VALUE } }]);
  });

  it("does not forward host values when no names were selected", async () => {
    const coordinator = await createCoordinator({ root: base });
    const session: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [], inheritedEnv: { [SECRET_NAME]: "not-selected" } };
    await coordinator.start({ requestId: randomUUID(), invocation: { mode: "direct", executable: process.execPath, args: [] },
      cwd: base, isolation: { backend: "none", required: false } }, session);
    expect(captured.launches).toEqual([{ inheritedEnv: {} }]);
  });

  it("ignores host overrides and caller inheritance for an approved schedule template", async () => {
    const coordinator = await createCoordinator({ root: base });
    const template: Omit<LaunchSpec, "requestId" | "createdAt"> = {
      invocation: { mode: "direct", executable: process.execPath, args: [] }, cwd: base,
      env: { [SECRET_NAME]: "approved-template-value" }, credentialRefs: [],
      isolation: { backend: "none", required: false }, ownershipScope: "unverified",
      limits: DEFAULT_RESOURCE_LIMITS, headless: true,
    };
    const grant = await coordinator.authorization.recordExplicitApproval("schedule-create", template);
    const session: SessionPolicySnapshot = { permissionMode: "deny-writes", headlessApprovedActions: [], inheritedEnv: { [SECRET_NAME]: "host-must-not-override-template" } };
    const requestId = randomUUID();
    await coordinator.start({ requestId, invocation: template.invocation, cwd: base, isolation: template.isolation,
      envInherit: [SECRET_NAME], scheduleGrant: { grantId: grant.grantId, template } }, session);
    expect(captured.launches).toEqual([{ inheritedEnv: {} }]);
    const spec = await coordinator.repositories.specs.get(requestId);
    expect(spec!.env).toEqual(template.env);
    expect(spec!.envInherit).toBeUndefined();
    for (const file of await filesUnder(coordinator.root)) expect(await readFile(file, "utf8"), file).not.toContain("host-must-not-override-template");
  });

  it("an idempotent retry with the same envInherit attaches; a changed secret value does not change the consent", async () => {
    const coordinator = await createCoordinator({ root: base });
    const request = {
      requestId: randomUUID(),
      invocation: { mode: "direct" as const, executable: process.execPath, args: ["-e", ""] },
      cwd: base,
      envInherit: [SECRET_NAME],
      isolation: { backend: "none" as const, required: false },
    };
    const session = { permissionMode: "auto-accept" as const, headlessApprovedActions: [] };
    const first = await coordinator.start(request, session);
    process.env[SECRET_NAME] = "rotated";
    expect((await coordinator.start(request, session)).jobId).toBe(first.jobId);
  });
});

describe("supervisor resolves inherited values at spawn", () => {
  it("takeInheritedEnvironment consumes the channel variable and tolerates malformed input", () => {
    const env: NodeJS.ProcessEnv = { [INHERITED_ENV_VAR]: JSON.stringify({ A: "1", B: 2 }) };
    expect(takeInheritedEnvironment(env, INHERITED_ENV_VAR)).toEqual({ A: "1" });
    expect(env[INHERITED_ENV_VAR]).toBeUndefined();
    expect(takeInheritedEnvironment({ [INHERITED_ENV_VAR]: "{not json" }, INHERITED_ENV_VAR)).toEqual({});
    expect(takeInheritedEnvironment({}, INHERITED_ENV_VAR)).toEqual({});
  });

  it("workloadEnvironment copies only the spec's envInherit names; explicit spec env wins", () => {
    const env = workloadEnvironment({ env: { PATH: "/p", B: "spec" }, envInherit: ["A", "B", "MISSING"] }, { A: "1", B: "inherited", C: "other" }, false);
    expect(env).toEqual({ PATH: "/p", A: "1", B: "spec" });
    expect(workloadEnvironment({ env: {}, envInherit: ["Path"] }, { Path: "x" }, true)).toEqual({ PATH: "x" });
  });

  it.skipIf(process.platform === "win32")("the workload receives the inherited value while the stored spec holds only its name", async () => {
    const sockBase = await mkdtemp(join(tmpdir(), "agav-sec-"));
    try {
      const root = await resolveStorageRoot(sockBase);
      const repositories = createFileRepositories(root);
      const requestId = randomUUID();
      const spec: LaunchSpec = {
        requestId,
        invocation: { mode: "direct", executable: process.execPath, args: ["-e", `process.stdout.write(process.env.${SECRET_NAME} ?? "absent")`] },
        cwd: sockBase,
        env: {},
        envInherit: [SECRET_NAME],
        credentialRefs: [],
        isolation: { backend: "none", required: false },
        ownershipScope: "process-group",
        limits: { logSegmentBytes: 1024 * 1024, retainedLogBytesPerJob: 10 * 1024 * 1024, aggregatePerUserLogBudgetBytes: 100 * 1024 * 1024, maxConcurrentJobs: 4, completedLogRetentionDays: 7 },
        headless: false,
        createdAt: new Date().toISOString(),
      };
      await repositories.specs.put(spec);
      const jobId = randomUUID();
      await repositories.jobs.create({ jobId, requestId, specHash: "test", protocolVersion: 1, state: "accepted", stopState: "none", nonce: randomUUID() });
      const supervisor = new JobSupervisor({ jobId, requestId, repositories, root, socketPath: getSocketPath(root, `job-${jobId}`), inheritedEnv: { [SECRET_NAME]: "from-channel" } });
      await supervisor.start(spec);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await repositories.jobs.get(jobId))?.state !== "completed") await new Promise((r) => setTimeout(r, 25));
      await supervisor.shutdown().catch(() => {});
      const logs = (await filesUnder(join(root, "jobs", jobId, "logs"))).filter((f) => f.includes("stdout"));
      const text = (await Promise.all(logs.map((f) => readFile(f, "utf8")))).join("");
      expect(text).toContain("from-channel");
      expect(await readFile(join(root, "specs", `${requestId}.json`), "utf8")).not.toContain("from-channel");
    } finally {
      await rm(sockBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
