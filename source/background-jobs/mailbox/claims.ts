/**
 * Ephemeral, in-memory presentation leases only. A claim is never an acknowledgement (there is
 * deliberately no timeout auto-ack); durable state lives in `Repositories.acks`.
 */
import type { ClientId, EventId } from "../types.js";

export class PresentationClaimTracker {
  private readonly claims = new Map<EventId, ClientId>();

  /** Re-claiming by the client that already holds it succeeds; a different holder returns false. */
  tryClaim(eventId: EventId, clientId: ClientId): boolean {
    const current = this.claims.get(eventId);
    if (current === undefined) {
      this.claims.set(eventId, clientId);
      return true;
    }
    return current === clientId;
  }

  /** No-op unless `clientId` holds the claim, so it is safe to call defensively. */
  release(eventId: EventId, clientId: ClientId): void {
    const current = this.claims.get(eventId);
    if (current === clientId) {
      this.claims.delete(eventId);
    }
  }

  /** Called on client disconnect so another client can pick the event up. */
  releaseAllForClient(clientId: ClientId): void {
    for (const [eventId, holder] of this.claims) {
      if (holder === clientId) this.claims.delete(eventId);
    }
  }

  getClaimant(eventId: EventId): ClientId | undefined {
    return this.claims.get(eventId);
  }
}
