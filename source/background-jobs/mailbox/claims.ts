/**
 * T13 — In-memory presentation-claim tracking for the completion mailbox.
 *
 * Claims are EPHEMERAL session-attachment state only. A claim records which
 * connected client is currently "holding" a completion event for
 * presentation (e.g. rendering a notification in a live session) so that
 * two connected clients do not simultaneously announce the same event.
 *
 * Claims are NOT durable and are NOT the source of truth for "has this
 * event been dealt with" — that is exclusively the persisted
 * `AcknowledgementRecord` reached through `Repositories.acks`. This class
 * holds nothing on disk and nothing survives a process restart; that is by
 * design per solution.md §10: "Disconnect releases an unacknowledged
 * presentation claim" and "a timeout is not an acknowledgement."
 *
 * IMPORTANT: there is deliberately NO timeout-based auto-ack anywhere in
 * this class. A claim that is never followed by an explicit, persisted
 * acknowledgement (via the repository, see `mailbox-service.ts`) is just an
 * in-memory presentation lease — it conveys no durable meaning and will
 * silently evaporate on disconnect/restart. Callers that want "this event
 * was actually acknowledged" must call the mailbox service's `acknowledge`
 * and check `isAcknowledged`/`repositories.acks.get`, never infer it from
 * claim state alone.
 */
import type { ClientId, EventId } from "../types.js";

export class PresentationClaimTracker {
  private readonly claims = new Map<EventId, ClientId>();

  /**
   * Attempts to claim `eventId` for `clientId`.
   *
   * - No existing claim: records the claim, returns true.
   * - Existing claim held by the SAME clientId: idempotent no-op, returns
   *   true (re-presenting to the client that already holds the claim is
   *   allowed, e.g. on reconnect-with-same-id or a retried notify).
   * - Existing claim held by a DIFFERENT clientId: returns false; the
   *   caller must not also present this event to `clientId`.
   */
  tryClaim(eventId: EventId, clientId: ClientId): boolean {
    const current = this.claims.get(eventId);
    if (current === undefined) {
      this.claims.set(eventId, clientId);
      return true;
    }
    return current === clientId;
  }

  /**
   * Releases a claim on `eventId`, but only if it is currently held by
   * exactly `clientId`. Releasing a claim held by someone else (or
   * releasing a claim that does not exist) is a no-op, not an error — this
   * keeps release safe to call defensively (e.g. in cleanup paths) without
   * requiring callers to first check ownership.
   */
  release(eventId: EventId, clientId: ClientId): void {
    const current = this.claims.get(eventId);
    if (current === clientId) {
      this.claims.delete(eventId);
    }
  }

  /**
   * Releases every claim currently held by `clientId`. Called on client
   * disconnect per solution.md §10: "Disconnect releases an unacknowledged
   * presentation claim." Claims already turned into a persisted
   * acknowledgement are unaffected by this (acks live in the repository,
   * not here) — this only clears the in-memory presentation lease so some
   * other connected client can pick the event up.
   */
  releaseAllForClient(clientId: ClientId): void {
    for (const [eventId, holder] of this.claims) {
      if (holder === clientId) this.claims.delete(eventId);
    }
  }

  /** Returns the clientId currently holding the claim on `eventId`, if any. */
  getClaimant(eventId: EventId): ClientId | undefined {
    return this.claims.get(eventId);
  }
}
