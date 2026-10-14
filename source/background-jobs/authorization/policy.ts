import type { GrantAction, SessionPolicySnapshot } from "../types.js";

export function isWriteAction(action: GrantAction): boolean {
  return action === "start" || action === "stop" || action === "cleanup" || action === "schedule-create";
}

/**
 * Deny-writes blocks only new launches. `stop`, `cleanup` and `schedule-revoke` stay
 * available as an emergency path (each still needs its own grant).
 */
export function isBlockedByDenyWrites(action: GrantAction): boolean {
  return action === "start" || action === "schedule-create";
}

/** An empty or missing approved list means NOT approved; never default to approved. */
export function isHeadlessActionApproved(action: GrantAction, session: SessionPolicySnapshot): boolean {
  return session.headlessApprovedActions.includes(action);
}
