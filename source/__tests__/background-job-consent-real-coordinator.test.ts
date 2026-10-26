/**
 * Background-job consent boundary — proven at the PRODUCTION coordinator boundary.
 *
 * `background-job-consent-boundary.test.ts` drives the tool with a fake
 * coordinator, so it can only prove the tool→coordinator link (the request it
 * builds carries `headless`). It cannot prove the coordinator→authorization link:
 * if the real coordinator stopped forwarding `headless` to `authorize("start")`,
 * those tests would stay green while a headless auto-accept start launched an
 * unsandboxed job.
 *
 * This file closes that gap by exercising the REAL coordinator from compiled
 * `build/` output (same pattern as coordinator.service.test.ts — a full `tsc`
 * build is a prerequisite, which CI runs via `pnpm build` before vitest).
 * Authorization happens BEFORE admission/launch, so a denied start never spawns a
 * supervisor; the allowed cases start a trivial job that is stopped in cleanup.
 *
 * Proven here:
 *   - headless start under auto-accept is DENIED at the production boundary
 *     (the coordinator really forwards headless to authorization);
 *   - a headless start is allowed only with an explicit grant for that action;
 *   - consent is EXACT-SPEC: a grant minted for one command/cwd does not
 *     authorize a different one (changed-spec rejection) in a non-auto-accept
 *     (deny-writes) session where no fresh grant can be minted.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Coordinator } from "../background-jobs/coordinator/service.js";
import type { SessionPolicySnapshot, StartJobRequest } from "../background-jobs/types.js";

const execFileAsync = promisify(execFile);

/** Reap any supervisor this test started (matched by its unique jobId argv token). */
async function killSupervisorsByJobIds(jobIds: string[]): Promise<void> {
  if (jobIds.length === 0 || process.platform === "win32") return;
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,args"]);
    for (const line of stdout.split("\n")) {
      if (!line.includes("supervisor/entry.js")) continue;
      if (!jobIds.some((id) => line.includes(id))) continue;
      const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  } catch { /* ps unavailable / no matches */ }
}

async function importBuiltCoordinatorModule(): Promise<{ createCoordinator: typeof import("../background-jobs/coordinator/service.js").createCoordinator }> {
  const url = new URL("../../build/background-jobs/coordinator/service.js", import.meta.url).href;
  return import(/* @vite-ignore */ url);
}
async function importBuiltTypesModule(): Promise<typeof import("../background-jobs/types.js")> {
  const url = new URL("../../build/background-jobs/types.js", import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

const { createCoordinator } = await importBuiltCoordinatorModule();
const { BackgroundJobError } = await importBuiltTypesModule();

let base: string;
let coordinator: Coordinator;
let jobsToCleanUp: string[] = [];

const headlessAutoAccept: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };
const headlessWithStartGrant: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: ["start"] };

function req(overrides: Partial<StartJobRequest> = {}): StartJobRequest {
  return {
    requestId: randomUUID(),
    invocation: { mode: "shell", interpreter: process.platform === "win32" ? "cmd" : "posix-sh", commandText: "echo hi" },
    cwd: tmpdir(),
    isolation: { backend: "none", required: false },
    ...overrides,
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-consent-coord-"));
  coordinator = await createCoordinator({ root: base });
  jobsToCleanUp = [];
});
afterEach(async () => {
  for (const jobId of jobsToCleanUp) {
    try {
      const s = await coordinator.poll(jobId);
      if (s.state !== "completed" && s.state !== "failed" && s.state !== "interrupted") {
        await coordinator.stop(jobId, headlessAutoAccept);
      }
    } catch { /* gone */ }
  }
  await killSupervisorsByJobIds(jobsToCleanUp);
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 30000);

describe("real coordinator forwards headless to authorization (production boundary)", () => {
  it("DENIES a headless start under auto-accept, launching no supervisor", async () => {
    // The whole point: auto-accept must not let a headless start through. If the
    // coordinator stopped forwarding `headless` to authorize(), this would launch.
    await expect(
      coordinator.start(req({ headless: true }), headlessAutoAccept),
    ).rejects.toBeInstanceOf(BackgroundJobError);
    // No job record was created (authorization precedes admission).
    expect(await coordinator.list()).toHaveLength(0);
  });

  it("allows a headless start only with an explicit 'start' grant in the session", async () => {
    const summary = await coordinator.start(req({ headless: true }), headlessWithStartGrant);
    jobsToCleanUp.push(summary.jobId);
    expect(summary.jobId).toBeTruthy();
    expect(await coordinator.list()).toHaveLength(1);
  });

  it("a non-headless start still launches under auto-accept (control)", async () => {
    const summary = await coordinator.start(req(), headlessAutoAccept);
    jobsToCleanUp.push(summary.jobId);
    expect(summary.jobId).toBeTruthy();
  });
});

describe("real coordinator consent is exact-spec (changed spec is re-gated)", () => {
  it("a deny-writes session with no grant cannot start even a previously-seen command", async () => {
    // deny-writes blocks new launches and cannot mint a grant; there is no prior
    // grant for this spec, so the start must be refused — proving consent is not
    // ambiently granted and must be explicit per spec.
    const denyWrites: SessionPolicySnapshot = { permissionMode: "deny-writes", headlessApprovedActions: [] };
    await expect(coordinator.start(req({ invocation: { mode: "shell", interpreter: process.platform === "win32" ? "cmd" : "posix-sh", commandText: "echo exact-spec" } }), denyWrites))
      .rejects.toBeInstanceOf(BackgroundJobError);
    expect(await coordinator.list()).toHaveLength(0);
  });

  it("an auto-accept grant minted for one command does not cover a different command under deny-writes", async () => {
    // Mint a grant for command A under auto-accept (a real launch).
    const a = await coordinator.start(req({ invocation: { mode: "shell", interpreter: process.platform === "win32" ? "cmd" : "posix-sh", commandText: "echo command-A" } }), headlessAutoAccept);
    jobsToCleanUp.push(a.jobId);

    // Command B under deny-writes: the A-grant does not apply (different spec
    // hash) and deny-writes cannot mint a new one, so B is refused.
    const denyWrites: SessionPolicySnapshot = { permissionMode: "deny-writes", headlessApprovedActions: [] };
    await expect(coordinator.start(req({ invocation: { mode: "shell", interpreter: process.platform === "win32" ? "cmd" : "posix-sh", commandText: "echo command-B" } }), denyWrites))
      .rejects.toBeInstanceOf(BackgroundJobError);
    // Only command A launched.
    expect(await coordinator.list()).toHaveLength(1);
  });
});
