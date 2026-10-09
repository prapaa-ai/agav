/**
 * T16 — Shared integration glue between the background-jobs subsystem and
 * the rest of the product (tools, slash commands). This file is explicitly
 * OUTSIDE `source/background-jobs/` per that directory's README ("T16
 * integration lives OUTSIDE this directory: source/tools/, source/commands/,
 * source/agent/") — it is product wiring, not a subsystem-internal module.
 *
 * Both `source/tools/background-job.ts` and `source/commands/process.ts`
 * need a `CoordinatorClient`. Rather than each constructing its own
 * `createCoordinator()` instance (wasteful, though not unsafe — the
 * coordinator is effectively stateless per-call against shared on-disk
 * storage, see coordinator/service.ts), this module lazily constructs ONE
 * shared instance the first time either caller needs it.
 */
import { createCoordinator, type Coordinator } from "./background-jobs/coordinator/index.js";
import { createScheduleEngine, type ScheduleEngine } from "./background-jobs/schedule/engine.js";
import type { SessionPolicySnapshot } from "./background-jobs/types.js";

let shared: Coordinator | Promise<Coordinator> | null = null;
let cachedScheduleEngine: ScheduleEngine | null = null;

/**
 * Lazily construct (on first call) and return the shared coordinator
 * singleton used by all T16 tool/command integration code. Never constructs
 * anything at import time, so simply importing this module (or a module
 * that imports it) has no I/O side effects.
 */
export async function getSharedCoordinator(): Promise<Coordinator> {
  if (shared === null) {
    shared = createCoordinator();
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
export function startScheduleTicker(getSession: () => SessionPolicySnapshot, intervalMs = 30_000): void {
  if (scheduleTickerHandle !== null) return;
  scheduleTickerHandle = setInterval(() => {
    void (async () => {
      try {
        const engine = await getSharedScheduleEngine();
        await engine.evaluateOnce({ nowUtc: new Date(), connectedSessions: [getSession()] });
      } catch {
        // A single bad tick must never crash the app or stop future ticks;
        // evaluateOnce() itself already isolates per-schedule failures
        // (see schedule/engine.ts), this is just an outer defensive guard
        // for anything upstream (e.g. the shared coordinator/engine failing
        // to construct at all, such as a storage permission problem).
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
