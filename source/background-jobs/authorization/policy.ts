/**
 * T08 — Pure, side-effect-free authorization policy predicates.
 *
 * No I/O lives here. `service.ts` composes these with the grant store and
 * spec hashing to produce `AuthorizationDecision`s.
 */
import type { GrantAction, SessionPolicySnapshot } from "../types.js";

/**
 * True for actions that write/mutate job or schedule state, as opposed to
 * read-only observation. Note `schedule-revoke` is intentionally NOT a write
 * action for the purposes of deny-writes gating below — see
 * `isBlockedByDenyWrites`.
 */
export function isWriteAction(action: GrantAction): boolean {
  return action === "start" || action === "stop" || action === "cleanup" || action === "schedule-create";
}

/**
 * Per solution.md §4: "Deny-writes blocks new manual and scheduled
 * launches... Stop is separately authorized so an explicitly requested
 * emergency stop remains possible; it is never silently treated as safe
 * introspection."
 *
 * Deny-writes blocks *new launches* (`start`, `schedule-create`). It does
 * NOT block `stop`, `cleanup` or `schedule-revoke` — these remain available
 * as a separately-authorized emergency/cleanup path (each still requires its
 * own grant via the normal authorize() flow; they are simply never
 * suppressed merely because deny-writes is active). This matches the
 * acceptance criterion "Stop has a separately authorized emergency path, not
 * a blanket read-only exemption": stop is its own sensitive action, not
 * treated as read-only, but it is also not blocked by deny-writes.
 */
export function isBlockedByDenyWrites(action: GrantAction): boolean {
  return action === "start" || action === "schedule-create";
}

/**
 * Per solution.md §4: "Headless execution needs an explicit applicable
 * grant; absent a handler is not consent." An empty or missing
 * `headlessApprovedActions` list must mean NOT approved — it must never
 * silently default to approved just because no explicit denial handler
 * exists.
 */
export function isHeadlessActionApproved(action: GrantAction, session: SessionPolicySnapshot): boolean {
  return session.headlessApprovedActions.includes(action);
}
