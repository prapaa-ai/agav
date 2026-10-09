/**
 * Session identity primitives (T06).
 *
 * IMPORTANT — Transport authentication is NOT user consent:
 * Successfully completing the IPC handshake only proves the connecting
 * process runs as the same OS user that owns the socket/pipe (enforced by
 * filesystem/pipe ACLs — see server.ts). It proves nothing about whether any
 * particular action (starting a job, stopping a job, creating a schedule,
 * etc.) is authorized. Per solution.md §4/§6, authorization is a completely
 * separate concern owned by T08's authorization/grant service and T14's
 * coordinator, which evaluate a `SessionPolicySnapshot` against the
 * requested action. This module deliberately contains NO authorization
 * logic — it only defines the data shape that ties a transport-level
 * `ClientId` to the session policy snapshot the caller supplies, so later
 * coordinator code has a stable place to look up "which policy applies to
 * this connection" without re-deriving it from scratch.
 */
import type { ClientId, SessionPolicySnapshot } from "../types.js";

export interface SessionHandle {
  readonly clientId: ClientId;
  readonly policy: SessionPolicySnapshot;
  /** ISO 8601 timestamp of when this handle was created (handshake completion time). */
  readonly connectedAt: string;
}

/**
 * Construct a `SessionHandle` pairing a connected client with the session
 * policy snapshot supplied for it. This is pure data assembly — callers
 * (T14) remain responsible for deciding *when* a snapshot is trustworthy and
 * for actually enforcing it (T08).
 */
export function createSessionHandle(clientId: ClientId, policy: SessionPolicySnapshot, connectedAt: string = new Date().toISOString()): SessionHandle {
  return { clientId, policy, connectedAt };
}
