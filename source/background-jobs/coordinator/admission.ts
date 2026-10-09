/**
 * T14 — Capacity bookkeeping against real repositories.
 *
 * Per solution.md §9: "Reserve capacity before launch... Unknown jobs count
 * against capacity until safely reconciled." This means `unknown` and
 * `recovery-required` lifecycle states STILL count as active/occupying a
 * capacity slot — only the three terminal states (`completed`, `failed`,
 * `interrupted`, see `isTerminalLifecycle` in `../types.js`) are excluded.
 *
 * This function does NOT itself acquire the coordinator lock. The caller
 * (`coordinator/service.ts`) is responsible for wrapping the full
 * check-then-create admission decision in `withCoordinatorLock` so that the
 * count here and the subsequent `repositories.jobs.create()` happen
 * atomically with respect to any other concurrent admission attempt in the
 * same process (or, via the OS-held lock, a different process sharing the
 * same storage root).
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
  // `root` is accepted (rather than only `repositories`) to mirror the
  // shape callers naturally have on hand (both are threaded together
  // throughout the coordinator) and to leave room for a future per-root
  // cache without changing this function's signature; it is not read here
  // because `repositories` already resolves all paths against its own
  // bound root.
  void root;

  const jobs = await repositories.jobs.list();
  const activeCount = jobs.filter((job) => !isTerminalLifecycle(job.state)).length;

  return {
    granted: activeCount < limits.maxConcurrentJobs,
    activeCount,
  };
}
