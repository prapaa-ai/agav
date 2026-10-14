/**
 * T16 — Shared integration glue between the background-jobs subsystem and
 * the rest of the product (tools, slash commands). This file is explicitly
 * OUTSIDE `source/background-jobs/` per that directory's README ("T16
 * integration lives OUTSIDE this directory: source/tools/, source/commands/,
 * source/agent/") — it is product wiring, not a subsystem-internal module.
 *
 * Both `source/tools/background-job.ts` and `source/commands/job.ts`
 * need a `CoordinatorClient`. Rather than each constructing its own
 * `createCoordinator()` instance (wasteful, though not unsafe — the
 * coordinator is effectively stateless per-call against shared on-disk
 * storage, see coordinator/service.ts), this module lazily constructs ONE
 * shared instance the first time either caller needs it.
 */
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

// --- 0.3 startup reconcile (D5) ---------------------------------------------

/** The first (in-flight or settled) startup reconcile; null until started. */
let startupReconcilePromise: Promise<void> | null = null;
let startupReconcileEnabled = true;

/**
 * Once per process, fire-and-forget reconcile of possibly-orphaned jobs
 * (D5): `running`/`unknown` jobs plus `accepted`/`starting` jobs older than
 * `olderThanMs` (default 2 minutes, the coordinator's own default). Job
 * selection lives in the coordinator's `reconcile()`.
 *
 * Returns synchronously, before any reconcile work runs (the work is
 * deferred to a microtask). The returned promise never rejects — every
 * error is swallowed (debug-logged) — so callers may simply `void` it; tests
 * may await it. Calls after the first do not start another reconcile; they
 * return the SAME promise as the first call, so a later `await
 * reconcileOnStartup(c)` (e.g. `agav job tick` after `getSharedCoordinator()`
 * already fired it) waits for the in-flight reconcile to finish.
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

/**
 * Test-only: clear the once-per-process guard and optionally enable/disable
 * the startup reconcile (default re-enables it). Mirrors the other
 * `__set*ForTests` / `__reset*ForTests` helpers in this file.
 */
export function __resetStartupReconcileForTests(opts?: { enabled?: boolean }): void {
  startupReconcilePromise = null;
  startupReconcileEnabled = opts?.enabled ?? true;
}

/**
 * Lazily construct (on first call) and return the shared coordinator
 * singleton used by all T16 tool/command integration code. Never constructs
 * anything at import time, so simply importing this module (or a module
 * that imports it) has no I/O side effects.
 *
 * Constructing the default instance also schedules the once-per-process,
 * non-blocking startup reconcile (0.3). Coordinators injected through
 * `__setSharedCoordinatorForTests` never trigger it.
 */
export async function getSharedCoordinator(): Promise<Coordinator> {
  if (shared === null) {
    shared = createCoordinator();
    void reconcileOnStartup(shared);
  }
  return shared;
}

/**
 * Test-only override so unit tests can inject a coordinator bound to a
 * temporary storage root (or null to force the next call to construct a
 * fresh default instance). Mirrors the established convention in
 * `source/background-jobs/platform/index.ts`'s `__setPlatformAdapterForTests`.
 */
export function __setSharedCoordinatorForTests(coordinator: Coordinator | null): void {
  shared = coordinator;
  cachedScheduleEngine = null;
}

/**
 * Lazily construct (on first call) and return the shared schedule engine
 * singleton used by all T16 tool/command integration code, built on top of
 * the shared coordinator singleton above.
 */
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

/**
 * Test-only override so unit tests can inject a schedule engine directly
 * (or null to force the next call to construct a fresh instance from the
 * current shared coordinator). Mirrors `__setSharedCoordinatorForTests`.
 */
export function __setSharedScheduleEngineForTests(engine: ScheduleEngine | null): void {
  cachedScheduleEngine = engine;
}

// --- 1.1 shared tick driver -------------------------------------------------

export interface BackgroundTickOptions {
  /** Schedule engine to evaluate. Defaults to one built on `coordinator`, else the shared engine. */
  scheduleEngine?: ScheduleEngine;
  /** Coordinator to build an engine from when `scheduleEngine` is omitted. */
  coordinator?: Coordinator;
  /** Permission session snapshot(s) to evaluate against ("connected sessions"). */
  session: SessionPolicySnapshot | SessionPolicySnapshot[];
  /** Evaluation time (default `new Date()`). */
  now?: Date;
  /** Config `backgroundAutomation`; `"paused"` returns early without dispatching. */
  backgroundAutomation?: "on" | "paused";
}

export interface BackgroundTickSummary {
  /** True when the tick was skipped because `backgroundAutomation === "paused"`. */
  paused: boolean;
  /** Schedules whose occurrence was dispatched. */
  dispatched: number;
  /** Schedules with a due occurrence that was skipped (overlap, capacity, policy, grant). */
  skipped: number;
  /** Tick-level failures (e.g. engine construction or evaluation threw). */
  errors: number;
  /** Messages for `errors`, in order. */
  errorMessages: string[];
  /** Raw per-schedule results from `evaluateOnce` (empty when paused or failed). */
  results: ScheduleEvaluationResult[];
}

/**
 * Run exactly one background tick: evaluate due process schedules via the
 * schedule engine's `evaluateOnce` (which reserves occurrences, dispatches
 * through the coordinator and updates schedule state) and summarize the
 * outcome. Shared by the interactive ticker and the headless `agav job
 * tick` / internal tick entry. Never throws; failures are counted in
 * `errors`.
 */
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
 * Start the periodic process-schedule evaluation ticker, if not already
 * running. Per solution.md §11: "The coordinator alone evaluates process
 * schedules across connected sessions. Keep the baseline of
 * interactive-only evaluation" — this ticker only runs while the
 * interactive app is alive; already-launched jobs continue after exit
 * regardless (unaffected by this ticker's lifetime).
 *
 * For this single-process interactive CLI, "connected sessions" is simply
 * the one session this app itself represents — there is no multi-client
 * concept here (unlike a hypothetical future always-on coordinator serving
 * several simultaneous clients). `getSession()` is called fresh on every
 * tick (not captured once at start time) so a live permissionMode change
 * (e.g. the user switches to deny-writes mid-session) is honored on the
 * very next tick, matching "recheck grant validity ... restrictive policy"
 * at trigger time per solution.md §11.
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
        // runBackgroundTick never throws; the guard below is for getSession /
        // getBackgroundAutomation. A single bad tick must never crash the
        // app or stop future ticks.
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

/** Stop the ticker started by `startScheduleTicker`, if running. Safe to call when not running. */
export function stopScheduleTicker(): void {
  if (scheduleTickerHandle !== null) {
    clearInterval(scheduleTickerHandle);
    scheduleTickerHandle = null;
  }
}

/** Test-only: force the ticker's internal "already running" state back to not-running without going through stop's clearInterval (useful after vi.useFakeTimers() manipulation). Mirrors other __setXForTests helpers in this file. */
export function __resetScheduleTickerForTests(): void {
  scheduleTickerHandle = null;
}
