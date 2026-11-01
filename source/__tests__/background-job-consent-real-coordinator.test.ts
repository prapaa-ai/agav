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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killWindowsFixtureSupervisor } from "./background-job-fixtures.js";
import type { Coordinator } from "../background-jobs/coordinator/service.js";
import type { SessionPolicySnapshot, StartJobRequest } from "../background-jobs/types.js";

const execFileAsync = promisify(execFile);

/**
 * Reap every supervisor this test started (matched by its unique jobId argv
 * token). T11 supervisors deliberately outlive their job until an idle timeout,
 * so each started job leaks one lightweight `node .../supervisor/entry.js`
 * process unless explicitly reaped — on BOTH platforms. Windows uses the
 * UUID-scoped fixture helper; POSIX matches the jobId in `ps` argv.
 */
async function killSupervisorsByJobIds(jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  if (process.platform === "win32") {
    for (const jobId of jobIds) {
      try { await killWindowsFixtureSupervisor(jobId); } catch { /* already gone */ }
    }
    return;
  }
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

const INTERP = process.platform === "win32" ? "cmd" : "posix-sh";

function req(overrides: Partial<StartJobRequest> = {}): StartJobRequest {
  return {
    requestId: randomUUID(),
    invocation: { mode: "shell", interpreter: INTERP, commandText: "echo hi" },
    cwd: tmpdir(),
    isolation: { backend: "none", required: false },
    ...overrides,
  };
}

/** A start request for a specific command (fresh requestId each call). */
function cmdReq(commandText: string, cwd: string = tmpdir()): StartJobRequest {
  return req({ invocation: { mode: "shell", interpreter: INTERP, commandText }, cwd });
}

/** An `ask`-mode session whose host confirm callback returns `decision`. */
function askSession(confirm: SessionPolicySnapshot["confirmBackgroundAction"]): SessionPolicySnapshot {
  return { permissionMode: "ask", headlessApprovedActions: [], confirmBackgroundAction: confirm };
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

describe("real coordinator consent is exact-spec (grant matching is reached)", () => {
  // These drive the `ask` path, which reaches grant lookup/matching
  // (findActiveBySpecHash) — unlike deny-writes, which short-circuits before the
  // spec hash. An interactive approval mints a grant for that EXACT spec; a later
  // identical spec reuses it WITHOUT asking, while any changed field must ask again.

  it("reuses an interactive grant for the identical spec WITHOUT asking again", async () => {
    const approve = vi.fn(async () => true);
    // First start: approved interactively → grant minted for this exact spec.
    const first = await coordinator.start(cmdReq("echo exact-reuse"), askSession(approve));
    jobsToCleanUp.push(first.jobId);
    expect(approve).toHaveBeenCalledTimes(1);

    // Identical command + cwd (fresh requestId): the grant covers it, so the
    // confirm callback must NOT be consulted again. A callback that would REJECT
    // proves the launch came from the stored grant, not a fresh approval.
    const reject = vi.fn(async () => false);
    const second = await coordinator.start(cmdReq("echo exact-reuse"), askSession(reject));
    jobsToCleanUp.push(second.jobId);
    expect(reject).not.toHaveBeenCalled();
    expect(await coordinator.list()).toHaveLength(2);
  });

  it("re-gates a CHANGED command (no grant, no callback → denied)", async () => {
    // Seed an approved grant for command A.
    const a = await coordinator.start(cmdReq("echo command-A"), askSession(vi.fn(async () => true)));
    jobsToCleanUp.push(a.jobId);

    // Command B: different spec hash, so the A-grant does not match. With no
    // confirm callback available, ask-mode has nothing to fall back on → denied.
    // This only passes if grant matching is spec-exact (a broken match that
    // reused A's grant for B would wrongly launch).
    await expect(coordinator.start(cmdReq("echo command-B"), askSession(undefined)))
      .rejects.toBeInstanceOf(BackgroundJobError);
    expect(await coordinator.list()).toHaveLength(1); // only A launched
  });

  it("re-gates a CHANGED working directory (cwd is part of the consent spec)", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "agav-consent-cwdA-"));
    const dirB = await mkdtemp(join(tmpdir(), "agav-consent-cwdB-"));
    try {
      // Approve the command in dirA.
      const a = await coordinator.start(cmdReq("echo same-command", dirA), askSession(vi.fn(async () => true)));
      jobsToCleanUp.push(a.jobId);

      // Same command, DIFFERENT cwd: the grant must not carry over. No callback →
      // denied, proving cwd participates in the exact-spec hash.
      await expect(coordinator.start(cmdReq("echo same-command", dirB), askSession(undefined)))
        .rejects.toBeInstanceOf(BackgroundJobError);
      expect(await coordinator.list()).toHaveLength(1);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });
});
