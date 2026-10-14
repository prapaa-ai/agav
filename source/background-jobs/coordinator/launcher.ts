/**
 * Starts the detached per-job supervisor; does not wait for the job to reach "running".
 * argv contract (must match supervisor/entry.ts): <jobId> <requestId> <root> <socketPath>.
 * The result is returned so the caller can persist supervisor ownership for later cleanup.
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
  void args.repositories;

  // Re-enter the bundled supervisor in standalone builds. Virtual JS paths
  // cannot be executed externally; Node/source builds retain the asset check.
  const standalone = isStandaloneBinary();
  const supervisorEntry = standalone ? SUPERVISOR_INTERNAL_FLAG : resolveSupervisorEntryPath();
  if (!standalone) await assertSupervisorAssetExists(supervisorEntry);

  const socketPath = getSocketPath(root, socketNameForJob(jobId));

  const adapter = await getPlatformAdapter();

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
