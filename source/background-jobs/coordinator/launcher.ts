/**
 * Starts the detached per-job supervisor; does not wait for the job to reach "running".
 * argv contract (must match supervisor/entry.ts): <jobId> <requestId> <root> <socketPath>.
 * The result is returned so the caller can persist supervisor ownership for later cleanup.
 */
import { BackgroundJobError, PreSpawnLaunchError, type DetachedLaunchResult, type Repositories } from "../types.js";
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
  void args.repositories;

  // Re-enter the bundled supervisor in standalone builds. Virtual JS paths
  // cannot be executed externally; Node/source builds retain the asset check.
  // Everything before `launchDetachedSupervisor` runs before any process exists, so a failure
  // here is definite (PreSpawnLaunchError): the caller may release the job's capacity.
  const standalone = isStandaloneBinary();
  let supervisorEntry: string;
  let socketPath: string;
  let adapter: Awaited<ReturnType<typeof getPlatformAdapter>>;
  try {
    supervisorEntry = standalone ? SUPERVISOR_INTERNAL_FLAG : resolveSupervisorEntryPath();
    if (!standalone) await assertSupervisorAssetExists(supervisorEntry);
    socketPath = getSocketPath(root, socketNameForJob(jobId));
    adapter = await getPlatformAdapter();
  } catch (error) {
    if (error instanceof PreSpawnLaunchError) throw error;
    throw new PreSpawnLaunchError(
      error instanceof BackgroundJobError ? error.code : "storage-unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }

  // Minimal env: PATH, plus NODE_OPTIONS when set (dev/test loaders may rely on it).
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
