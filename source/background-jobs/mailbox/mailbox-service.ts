/**
 * Completion-event mailbox. Delivery is at-least-once: a crash between presenting and
 * `acknowledge()` can duplicate a message, and the notify/acknowledge ordering is the caller's
 * choice. Job success never depends on notification success (no job state is touched here).
 */
import type { ClientId, CompletionEventRecord, EventId, Repositories } from "../types.js";
import { PresentationClaimTracker } from "./claims.js";

export interface MailboxService {
  listPendingForPresentation(): Promise<CompletionEventRecord[]>;

  /** Fails (`claimed: false`) if the event is already acknowledged or another client holds the claim. */
  claimForPresentation(eventId: EventId, clientId: ClientId): Promise<{ claimed: boolean; event?: CompletionEventRecord }>;

  releaseClaim(eventId: EventId, clientId: ClientId): void;

  releaseAllClaimsForClient(clientId: ClientId): void;

  /** Persists a durable acknowledgement and releases the claim. */
  acknowledge(eventId: EventId, clientId: ClientId): Promise<void>;

  isAcknowledged(eventId: EventId): Promise<boolean>;

  /** Isolates and retries (bounded backoff) each subscriber; never throws, reports failures instead. */
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
      // listPending() already excludes acked events.
      return repositories.events.listPending();
    },

    async claimForPresentation(
      eventId: EventId,
      clientId: ClientId,
    ): Promise<{ claimed: boolean; event?: CompletionEventRecord }> {
      // Only re-announcement is gated; any client can still read the event via `events.get`.
      if (await isAcknowledged(eventId)) {
        return { claimed: false };
      }

      const claimed = claims.tryClaim(eventId, clientId);
      if (!claimed) {
        return { claimed: false };
      }

      const event = await repositories.events.get(eventId);
      if (event === undefined) {
        // Event vanished (not expected: events are immutable); don't leave the claim dangling.
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
