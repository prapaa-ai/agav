/**
 * T10 — Logging-failure policy decision (pure, side-effect-free).
 *
 * Per solution.md §9: "If persistence or segment deletion fails, apply the
 * approved logging-failure policy: by default request stop, drain/discard
 * during termination and expose dropped-output diagnostics."
 *
 * Handoff boundary: this module ONLY computes what should happen. It never
 * stops, signals, or otherwise acts on a process — per the T10 ownership
 * rule "Do not independently signal processes" (subtasks.md) and the module
 * boundary in types.ts ("logging/* reports failures via callback, never
 * imports supervisor/coordinator"). The supervisor (T11) is the consumer:
 * it receives `onFailure(reason)` callbacks from `SegmentedLogWriter`,
 * passes the reason through `describeLoggingFailureAction`, and then is
 * responsible for actually calling the platform adapter's
 * `stopOwnedScope`/`forceStopOwnedScope` and for draining/discarding output
 * per `drainBehavior`. Nothing in `logging/*` ever imports or calls those
 * adapter functions directly.
 */

/** The only policy implemented for Phase A/B: always request a stop on logging failure. */
export type LoggingFailurePolicy = "request-stop-and-drain";

export interface LoggingFailureAction {
  /** What the supervisor should do: request a stop of the owned workload scope. */
  action: "request-stop";
  /** How the supervisor should handle in-flight output while draining toward termination. */
  drainBehavior: "discard-after-stop";
  /** Human-readable diagnostic to surface to the user/coordinator (dropped-output diagnostics). */
  diagnostic: string;
}

/**
 * Translates a raw logging-failure reason (e.g. from
 * `SegmentedLogWriter`'s `onFailure` callback) into the structured decision
 * the DEFAULT `request-stop-and-drain` policy prescribes. This function does
 * not stop anything itself — see module-level handoff-boundary doc above.
 */
export function describeLoggingFailureAction(reason: string): LoggingFailureAction {
  return {
    action: "request-stop",
    drainBehavior: "discard-after-stop",
    diagnostic: `logging failure, requesting stop: ${reason}`,
  };
}
