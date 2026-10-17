import { createCoordinator, type Coordinator } from "./background-jobs/coordinator/index.js";
import {
  createScheduleEngine,
  type ScheduleEngine,
  type ScheduleEvaluationResult,
} from "./background-jobs/schedule/engine.js";
import type { SessionPolicySnapshot } from "./background-jobs/types.js";

let shared: Coordinator | Promise<Coordinator> | null = null;
let cachedScheduleEngine: ScheduleEngine | null = null;

/** Debug-only logging for swallowed background errors (set AGAV_DEBUG=1). */
function debugLog(message: string, err?: unknown): void {
  if (!process.env["AGAV_DEBUG"]) return;
  const detail = err instanceof Error ? err.message : err === undefined ? "" : String(err);
  process.stderr.write(`[agav:background-jobs] ${message}${detail ? `: ${detail}` : ""}\n`);
}

let startupReconcilePromise: Promise<void> | null = null;
let startupReconcileEnabled = true;

/**
 * Once per process, fire-and-forget reconcile of possibly-orphaned jobs.
 * Never rejects; later calls return the first call's promise.
 */
export function reconcileOnStartup(
  coordinator: Coordinator | Promise<Coordinator>,
  opts?: { olderThanMs?: number },
): Promise<void> {
  if (startupReconcilePromise !== null) return startupReconcilePromise;
  if (!startupReconcileEnabled) return Promise.resolve();
  startupReconcilePromise = Promise.resolve()
    .then(async () => {
      const resolved = await coordinator;
      await resolved.reconcile(opts?.olderThanMs === undefined ? undefined : { olderThanMs: opts.olderThanMs });
    })
    .catch((err: unknown) => {
      debugLog("startup reconcile failed", err);
    });
  return startupReconcilePromise;
}

/** Test-only: clear the once-per-process guard; `enabled: false` disables the reconcile. */
export function __resetStartupReconcileForTests(opts?: { enabled?: boolean }): void {
  startupReconcilePromise = null;
  startupReconcileEnabled = opts?.enabled ?? true;
}

/**
 * Lazily constructs the shared coordinator (no I/O at import time) and schedules
 * the startup reconcile. Coordinators injected for tests never trigger it.
 */
export async function getSharedCoordinator(): Promise<Coordinator> {
  if (shared === null) {
    shared = createCoordinator();
    void reconcileOnStartup(shared);
  }
  return shared;
}

/** Test-only: inject a coordinator, or null to rebuild the default. */
export function __setSharedCoordinatorForTests(coordinator: Coordinator | null): void {
  shared = coordinator;
  cachedScheduleEngine = null;
}

export async function getSharedScheduleEngine(): Promise<ScheduleEngine> {
  if (cachedScheduleEngine === null) {
    const coordinator = await getSharedCoordinator();
    cachedScheduleEngine = createScheduleEngine({
      repositories: coordinator.repositories,
      coordinator,
      authorizationService: coordinator.authorization,
      root: coordinator.root,
    });
  }
  return cachedScheduleEngine;
}

/** Test-only: inject a schedule engine, or null to rebuild from the shared coordinator. */
export function __setSharedScheduleEngineForTests(engine: ScheduleEngine | null): void {
  cachedScheduleEngine = engine;
}

export interface BackgroundTickOptions {
  /** Defaults to an engine built on `coordinator`, else the shared engine. */
  scheduleEngine?: ScheduleEngine;
  coordinator?: Coordinator;
  session: SessionPolicySnapshot | SessionPolicySnapshot[];
  now?: Date;
  /** Config `backgroundAutomation`; `"paused"` returns early without dispatching. */
  backgroundAutomation?: "on" | "paused";
}

export interface BackgroundTickSummary {
  paused: boolean;
  dispatched: number;
  /** Due occurrences skipped (overlap, capacity, policy, grant). */
  skipped: number;
  errors: number;
  errorMessages: string[];
  /** Raw per-schedule results from `evaluateOnce` (empty when paused or failed). */
  results: ScheduleEvaluationResult[];
}

/** Runs one schedule evaluation pass and summarizes it. Never throws; failures are counted in `errors`. */
export async function runBackgroundTick(opts: BackgroundTickOptions): Promise<BackgroundTickSummary> {
  const summary: BackgroundTickSummary = {
    paused: false,
    dispatched: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
    results: [],
  };
  if (opts.backgroundAutomation === "paused") {
    summary.paused = true;
    return summary;
  }
  try {
    const engine =
      opts.scheduleEngine ??
      (opts.coordinator
        ? createScheduleEngine({
            repositories: opts.coordinator.repositories,
            coordinator: opts.coordinator,
            authorizationService: opts.coordinator.authorization,
            root: opts.coordinator.root,
          })
        : await getSharedScheduleEngine());
    const sessions = Array.isArray(opts.session) ? opts.session : [opts.session];
    const results = await engine.evaluateOnce({ nowUtc: opts.now ?? new Date(), connectedSessions: sessions });
    summary.results = results;
    for (const result of results) {
      if (result.outcome === "dispatched") summary.dispatched += 1;
      else if (result.outcome !== "no-occurrence-due") summary.skipped += 1;
    }
  } catch (err) {
    summary.errors += 1;
    summary.errorMessages.push(err instanceof Error ? err.message : String(err));
    debugLog("background tick failed", err);
  }
  return summary;
}

let scheduleTickerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Evaluates process schedules periodically while the interactive app is alive;
 * already-launched jobs outlive it. `getSession` is re-read every tick so a
 * permission-mode change applies on the next one.
 */
export function startScheduleTicker(
  getSession: () => SessionPolicySnapshot,
  intervalMs = 30_000,
  opts?: { getBackgroundAutomation?: () => "on" | "paused" | undefined },
): void {
  if (scheduleTickerHandle !== null) return;
  scheduleTickerHandle = setInterval(() => {
    void (async () => {
      try {
        // Guards getSession/getBackgroundAutomation throwing; a bad tick must not stop later ones.
        await runBackgroundTick({
          session: getSession(),
          backgroundAutomation: opts?.getBackgroundAutomation?.(),
        });
      } catch (err) {
        debugLog("schedule ticker tick failed", err);
      }
    })();
  }, intervalMs);
  scheduleTickerHandle.unref?.();
}

export function stopScheduleTicker(): void {
  if (scheduleTickerHandle !== null) {
    clearInterval(scheduleTickerHandle);
    scheduleTickerHandle = null;
  }
}

/** Test-only: clear the "already running" state without clearInterval (e.g. after fake timers). */
export function __resetScheduleTickerForTests(): void {
  scheduleTickerHandle = null;
}
