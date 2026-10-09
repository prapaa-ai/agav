/**
 * T14 — Starts the per-job supervisor process.
 *
 * This module's whole job is to get the detached supervisor process
 * started. It does NOT wait for the job to reach "running" — the caller
 * (`coordinator/service.ts#start`) polls the job record afterward for a
 * short, bounded window per solution.md §2's "Non-blocking launch, with
 * distinct accepted, starting and running outcomes."
 *
 * Contract this must match exactly (see supervisor/entry.ts's module doc
 * and `__tests__/supervisor.lifecycle.test.ts`'s `setup()` helper):
 *   argv:        <jobId> <requestId> <root> <socketPath>
 *   socket name: `job-${jobId}` passed through `getSocketPath(root, name)`
 *
 * The supervisor itself re-derives its own socket path from argv (it never
 * calls `getSocketPath` itself — see entry.ts), so as long as THIS module
 * computes the path the same way callers elsewhere in the coordinator do
 * (see `service.ts`'s `socketPathFor`), there is no hidden coupling beyond
 * "both sides agree on the literal string passed over argv".
 *
 * Fix B (reaping via `cleanup()`): this function now returns the
 * `DetachedLaunchResult` produced by `adapter.launchDetachedSupervisor(...)`
 * instead of discarding it. The caller (`service.ts#start`) persists this
 * onto the job record as `supervisorIdentity`/`supervisorOwnershipHandle`/
 * `supervisorOwnershipScope` so a later `coordinator.cleanup()` call can
 * terminate the supervisor process itself via `PlatformAdapter.stopOwnedScope`
 * — see types.ts's JobRecord doc for why these fields are distinct from the
 * WORKLOAD's own `identity`/`ownershipHandle`/`ownershipScope`.
 */
import type { DetachedLaunchResult, Repositories } from "../types.js";
import { getPlatformAdapter } from "../platform/index.js";
import { resolveSupervisorEntryPath, assertSupervisorAssetExists } from "../packaging/locator.js";
import { isStandaloneBinary, SUPERVISOR_INTERNAL_FLAG } from "../packaging/manifest.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { buildMinimalEnvironment, normalizeWindowsEnvKeyCasing } from "../launch-spec/environment.js";

export interface LaunchSupervisorForJobArgs {
  jobId: string;
  requestId: string;
  root: string;
  repositories: Repositories;
}

/** Deterministically derive a job's IPC socket/pipe name. Shared by coordinator and tests. */
export function socketNameForJob(jobId: string): string {
  return `job-${jobId}`;
}

export async function launchSupervisorForJob(args: LaunchSupervisorForJobArgs): Promise<DetachedLaunchResult> {
  const { jobId, requestId, root } = args;
  // `repositories` is accepted for interface symmetry with the rest of the
  // coordinator (and in case a future revision needs to read the spec/job
  // record before launch), but this function does not need it today: the
  // spec is already persisted by `service.ts#start` before this is called,
  // and `entry.ts` reads it itself via its own `createFileRepositories(root)`.
  void args.repositories;

  // Re-enter the bundled supervisor in standalone builds. Virtual JS paths
  // cannot be executed externally; Node/source builds retain the asset check.
  const standalone = isStandaloneBinary();
  const supervisorEntry = standalone ? SUPERVISOR_INTERNAL_FLAG : resolveSupervisorEntryPath();
  if (!standalone) await assertSupervisorAssetExists(supervisorEntry);

  const socketPath = getSocketPath(root, socketNameForJob(jobId));

  const adapter = await getPlatformAdapter();

  // Minimal passthrough environment: PATH so Node itself (and anything it
  // needs to resolve) can be found, plus whatever the current process's own
  // module resolution needs on this host. Empirically, Node's own module
  // loader for a plain `.js` file invoked via `process.execPath` does not
  // need anything beyond PATH; we also forward NODE_OPTIONS when set
  // because dev/test environments sometimes rely on it (e.g. loaders),
  // mirroring the "minimal, documented environment" posture used in
  // launch-spec/environment.ts for actual workloads.
  const env: Record<string, string> = adapter.platform === "win32"
    ? normalizeWindowsEnvKeyCasing(buildMinimalEnvironment("win32").env)
    : {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.NODE_OPTIONS !== undefined) env.NODE_OPTIONS = process.env.NODE_OPTIONS;

  return adapter.launchDetachedSupervisor({
    supervisorEntry,
    argv: [jobId, requestId, root, socketPath],
    env,
    cwd: process.cwd(),
  });
}
