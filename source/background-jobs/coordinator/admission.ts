/**
 * Unknown and recovery-required jobs still occupy a capacity slot; only terminal states are excluded.
 * Does not take the coordinator lock: the caller must hold it across check + create.
 */
import { isTerminalLifecycle, type Repositories } from "../types.js";

export interface ReserveCapacityResult {
  granted: boolean;
  activeCount: number;
}

export async function reserveCapacity(
  repositories: Repositories,
  root: string,
  limits: { maxConcurrentJobs: number },
): Promise<ReserveCapacityResult> {
  void root;

  const jobs = await repositories.jobs.list();
  const activeCount = jobs.filter((job) => !isTerminalLifecycle(job.state)).length;

  return {
    granted: activeCount < limits.maxConcurrentJobs,
    activeCount,
  };
}
