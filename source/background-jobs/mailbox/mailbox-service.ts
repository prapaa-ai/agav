/**
 * T13 — Completion-event mailbox service.
 *
 * Implements solution.md §10 ("Completion delivery") on top of the frozen
 * `Repositories` contract (T05) and the in-memory `PresentationClaimTracker`
 * in this directory. This module builds the mailbox SERVICE only — it is
 * driven directly by tests (and, later, by T14's coordinator); it does not
 * run a coordinator loop, does not own any transport, and does not import
 * any UI code, per README.md's module-boundary rule ("mailbox does not
 * import UI").
 *
 * Contract-verification note (see also the handoff report): T05's actual
 * `events.listPending()` implementation (storage/repositories.ts) already
 * cross-references the acks directory and excludes any event that has at
 * least one persisted acknowledgement — see `listAckIds`/`ackedEventIds` in
 * that file. This mailbox layer therefore does NOT re-filter
 * `listPendingForPresentation()` against acks itself (that would be
 * redundant double-filtering of the exact same durable state) and simply
 * delegates. If that T05 behavior ever regresses, the dedicated test in
 * `__tests__/mailbox.service.test.ts` ("listPendingForPresentation excludes
 * an already-acked event") will catch it from this layer's perspective too.
 *
 * Durability model (solution.md §10):
 *   - "The coordinator treats events as a durable mailbox: assign one
 *     connected client, present with event-ID deduplication, then persist
 *     its acknowledgement separately." The in-memory `PresentationClaimTracker`
 *     implements the "assign one connected client" step; `acknowledge()`
 *     implements the "persist its acknowledgement separately" step.
 *   - "Disconnect releases an unacknowledged presentation claim; a timeout
 *     is not an acknowledgement." See `releaseAllClaimsForClient` and
 *     `claims.ts`'s module doc — there is no auto-ack anywhere here.
 *   - "All clients can inspect results even when a shared per-user
 *     acknowledgement suppresses repeat announcements." Any client can
 *     always read event data directly via `repositories.events.get` (a
 *     trivial, already-available read path — this service adds no special
 *     "inspect" method because none is needed). What IS gated here is the
 *     PRESENTATION/notification claim: once an event is acknowledged by any
 *     client, `claimForPresentation` will no longer hand out a *new*
 *     presentation claim for it, because the point of presenting it (to
 *     announce the outcome) has already been served. This is a deliberate
 *     asymmetry: inspection stays universally available, re-announcement
 *     does not.
 *   - "A crash after presentation but before acknowledgement can duplicate
 *     a message. Mark-before-notify can lose one." `acknowledge()` only
 *     performs the "mark" (durable ack persistence) half of that tradeoff;
 *     this module does not impose or assume any particular ordering between
 *     a caller's own notify step and its call to `acknowledge()` — ordering
 *     policy is the caller's (coordinator's) concern, consistent with
 *     "Guarantee recoverability of retained pending events, not
 *     exactly-once human-visible delivery."
 *   - "Job success is independent of notification success." This module
 *     never reads or writes `JobRecord` lifecycle state and never imports
 *     `supervisor/*` or `coordinator/*` — there is nothing here that could
 *     feed back into job success/failure even accidentally. Boundary is
 *     enforced structurally (no import exists), not by a runtime check.
 */
import type { ClientId, CompletionEventRecord, EventId, Repositories } from "../types.js";
import { PresentationClaimTracker } from "./claims.js";

export interface MailboxService {
  /** Dedup-ready pending (unacknowledged) completion events. */
  listPendingForPresentation(): Promise<CompletionEventRecord[]>;

  /**
   * Attempts to claim `eventId` for presentation to `clientId`. Fails
   * (`claimed: false`, no `event`) if the event is already acknowledged, or
   * if a different client currently holds the in-memory presentation
   * claim. On success returns the event record for the caller to present.
   */
  claimForPresentation(eventId: EventId, clientId: ClientId): Promise<{ claimed: boolean; event?: CompletionEventRecord }>;

  /** Releases `clientId`'s presentation claim on `eventId`, if held. */
  releaseClaim(eventId: EventId, clientId: ClientId): void;

  /** Releases every presentation claim currently held by `clientId` (disconnect). */
  releaseAllClaimsForClient(clientId: ClientId): void;

  /** Persists a durable acknowledgement and releases the claimant's presentation claim. */
  acknowledge(eventId: EventId, clientId: ClientId): Promise<void>;

  /** True iff at least one client has persisted an acknowledgement for `eventId`. */
  isAcknowledged(eventId: EventId): Promise<boolean>;

  /**
   * Invokes each subscriber with `event`, isolating one subscriber's
   * failure from the others, retrying a failing subscriber with bounded
   * exponential backoff, and NEVER throwing/rejecting itself. Returns a
   * diagnostics summary per solution.md §10 ("visible delivery
   * diagnostics").
   */
  notifySubscribers(
    event: CompletionEventRecord,
    subscribers: Array<(e: CompletionEventRecord) => void | Promise<void>>,
    opts?: { maxRetries?: number; baseDelayMs?: number },
  ): Promise<{ succeeded: number; failed: Array<{ index: number; error: string }> }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMailboxService(repositories: Repositories): MailboxService {
  const claims = new PresentationClaimTracker();

  async function isAcknowledged(eventId: EventId): Promise<boolean> {
    return (await repositories.acks.get(eventId)) !== undefined;
  }

  return {
    async listPendingForPresentation(): Promise<CompletionEventRecord[]> {
      // T05's listPending() already excludes acked events (see module doc).
      return repositories.events.listPending();
    },

    async claimForPresentation(
      eventId: EventId,
      clientId: ClientId,
    ): Promise<{ claimed: boolean; event?: CompletionEventRecord }> {
      // Once acknowledged, do not (re)issue a presentation claim to a new
      // client — the announcement purpose is already served. Inspection of
      // the event's data remains available to every client via
      // `repositories.events.get` regardless of this check; only the
      // presentation/notification claim is gated here.
      if (await isAcknowledged(eventId)) {
        return { claimed: false };
      }

      const claimed = claims.tryClaim(eventId, clientId);
      if (!claimed) {
        return { claimed: false };
      }

      const event = await repositories.events.get(eventId);
      if (event === undefined) {
        // Event vanished (should not happen in practice — events are
        // immutable once created). Release the claim we just took so it
        // does not dangle on a nonexistent event, and report failure.
        claims.release(eventId, clientId);
        return { claimed: false };
      }
      return { claimed: true, event };
    },

    releaseClaim(eventId: EventId, clientId: ClientId): void {
      claims.release(eventId, clientId);
    },

    releaseAllClaimsForClient(clientId: ClientId): void {
      claims.releaseAllForClient(clientId);
    },

    async acknowledge(eventId: EventId, clientId: ClientId): Promise<void> {
      await repositories.acks.create({
        eventId,
        clientId,
        acknowledgedAt: new Date().toISOString(),
      });
      // Acknowledging implicitly completes/releases this client's
      // presentation claim; see module doc re: mark-before-notify ordering
      // being the caller's concern, not enforced here.
      claims.release(eventId, clientId);
    },

    isAcknowledged,

    async notifySubscribers(
      event: CompletionEventRecord,
      subscribers: Array<(e: CompletionEventRecord) => void | Promise<void>>,
      opts?: { maxRetries?: number; baseDelayMs?: number },
    ): Promise<{ succeeded: number; failed: Array<{ index: number; error: string }> }> {
      const maxRetries = opts?.maxRetries ?? 2;
      const baseDelayMs = opts?.baseDelayMs ?? 50;

      let succeeded = 0;
      const failed: Array<{ index: number; error: string }> = [];

      await Promise.all(
        subscribers.map(async (subscriber, index) => {
          let attempt = 0;
          let lastError: unknown;
          while (attempt <= maxRetries) {
            try {
              await subscriber(event);
              succeeded += 1;
              return;
            } catch (error) {
              lastError = error;
              attempt += 1;
              if (attempt > maxRetries) break;
              await sleep(baseDelayMs * 2 ** (attempt - 1));
            }
          }
          failed.push({ index, error: errorMessage(lastError) });
        }),
      );

      return { succeeded, failed };
    },
  };
}
