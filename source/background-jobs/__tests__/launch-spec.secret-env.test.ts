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
import type { LaunchSpec } from "../types.js";

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
