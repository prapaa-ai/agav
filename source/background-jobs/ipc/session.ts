import type { ClientId, SessionPolicySnapshot } from "../types.js";

// A completed IPC handshake only proves the peer runs as the socket owner's OS user,
// NOT that any action is authorized. Authorization is evaluated elsewhere against
// `policy`; this module deliberately contains none.
export interface SessionHandle {
  readonly clientId: ClientId;
  readonly policy: SessionPolicySnapshot;
  /** ISO 8601 handshake completion time. */
  readonly connectedAt: string;
}

export function createSessionHandle(clientId: ClientId, policy: SessionPolicySnapshot, connectedAt: string = new Date().toISOString()): SessionHandle {
  return { clientId, policy, connectedAt };
}
