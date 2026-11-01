import { randomUUID } from "node:crypto";

import type {
  AuthorizationDecision,
  ConfirmSubject,
  Grant,
  GrantAction,
  GrantId,
  IsolationBackend,
  IsolationPolicy,
  PlatformCapabilities,
  SessionPolicySnapshot,
} from "../types.js";
import { createGrantStore } from "./grant-store.js";
import { isBlockedByDenyWrites, isHeadlessActionApproved } from "./policy.js";
import { hashLaunchSpecForConsent, type ConsentRelevantSpec } from "./spec-hash.js";

export interface IsolationResolution {
  backend: IsolationBackend;
  refused: boolean;
  reason?: string;
}

export interface AuthorizationService {
  authorize(
    action: GrantAction,
    spec: ConsentRelevantSpec,
    session: SessionPolicySnapshot,
    opts?: { headless?: boolean; subject?: ConfirmSubject },
  ): Promise<AuthorizationDecision>;

  /** Mints+persists a grant unconditionally; used after a human says yes in 'ask' mode. */
  recordExplicitApproval(action: GrantAction, spec: ConsentRelevantSpec): Promise<Grant>;

  /** Re-checks a previously-granted approval against the current spec before dispatch. */
  revalidateBeforeDispatch(grantId: GrantId, spec: ConsentRelevantSpec): Promise<AuthorizationDecision>;

  /** Blocks future launches only; must not stop running jobs (that needs a separately authorized `stop`). */
  revoke(grantId: GrantId): Promise<void>;

  resolveIsolation(requested: IsolationPolicy, capabilities: PlatformCapabilities): IsolationResolution;

  aggregateRestrictivePolicy(sessions: SessionPolicySnapshot[]): { blocksNewLaunches: boolean; reason?: string };
}

function mintGrant(action: GrantAction, specHash: string): Grant {
  return {
    grantId: randomUUID(),
    action,
    specHash,
    createdAt: new Date().toISOString(),
  };
}

export function createAuthorizationService(root: string): AuthorizationService {
  const grantStore = createGrantStore(root);

  return {
    async authorize(action, spec, session, opts) {
      if (session.signal?.aborted) return { allowed: false, reason: "Background action cancelled." };

      // Headless gate runs BEFORE permissionMode so auto-accept can't bypass it.
      if (opts?.headless && !isHeadlessActionApproved(action, session)) {
        return {
          allowed: false,
          reason: "Headless execution requires an explicit applicable grant; none is present.",
        };
      }

      if (isBlockedByDenyWrites(action) && session.permissionMode === "deny-writes") {
        return { allowed: false, reason: "deny-writes permission mode blocks this action." };
      }

      const specHash = hashLaunchSpecForConsent(spec);

      const existing = await grantStore.findActiveBySpecHash(action, specHash);
      if (existing !== undefined) {
        return { allowed: true, reason: "Existing grant covers this exact spec.", grant: existing };
      }

      if (session.permissionMode === "auto-accept") {
        const grant = mintGrant(action, specHash);
        await grantStore.put(grant);
        return { allowed: true, reason: "auto-accept permission mode.", grant };
      }

      // The confirm callback comes from the host, not model/tool arguments.
      // deny-writes still allows confirmation of stop/cleanup/schedule-revoke.
      const canConfirm = session.permissionMode === "ask" || session.permissionMode === "deny-writes";
      if (canConfirm && !opts?.headless && session.confirmBackgroundAction) {
        const approvedSpec = structuredClone(spec);
        let onAbort: (() => void) | undefined;
        try {
          const cancelled = new Promise<boolean>((resolve) => {
            onAbort = () => resolve(false);
            session.signal?.addEventListener("abort", onAbort, { once: true });
            if (session.signal?.aborted) resolve(false);
          });
          const accepted = await Promise.race([
            // Pass the watched signal as the 4th arg so the host can withdraw its prompt; trailing
            // arguments are omitted when absent so existing 2/3-arg implementations see no change.
            session.signal !== undefined
              ? session.confirmBackgroundAction(action, structuredClone(approvedSpec), opts?.subject, session.signal)
              : opts?.subject === undefined
                ? session.confirmBackgroundAction(action, structuredClone(approvedSpec))
                : session.confirmBackgroundAction(action, structuredClone(approvedSpec), opts.subject),
            cancelled,
          ]);
          if (accepted !== true || session.signal?.aborted || hashLaunchSpecForConsent(spec) !== specHash) {
            return { allowed: false, reason: "Background action rejected, cancelled, or changed." };
          }
          const grant = await this.recordExplicitApproval(action, approvedSpec);
          return { allowed: true, reason: "Explicit interactive approval.", grant };
        } catch {
          return { allowed: false, reason: "Background confirmation failed or was cancelled." };
        } finally {
          if (onAbort) session.signal?.removeEventListener("abort", onAbort);
        }
      }

      return {
        allowed: false,
        reason: "Requires interactive confirmation; no existing grant for this exact specification.",
      };
    },

    async recordExplicitApproval(action, spec) {
      const specHash = hashLaunchSpecForConsent(spec);
      const grant = mintGrant(action, specHash);
      await grantStore.put(grant);
      return grant;
    },

    async revalidateBeforeDispatch(grantId, spec) {
      const grant = await grantStore.get(grantId);
      if (grant === undefined) {
        return { allowed: false, reason: `No grant found for grantId "${grantId}".` };
      }
      if (grant.revokedAt !== undefined) {
        return { allowed: false, reason: "Grant has been revoked.", grant };
      }
      const currentHash = hashLaunchSpecForConsent(spec);
      if (currentHash !== grant.specHash) {
        return {
          allowed: false,
          reason: "Launch specification changed since approval; renewed consent required.",
        };
      }
      return { allowed: true, reason: "Grant revalidated against current specification.", grant };
    },

    async revoke(grantId) {
      await grantStore.revoke(grantId);
    },

    resolveIsolation(requested, capabilities) {
      // backend:'none' is an explicitly requested unrestricted mode, never a fallback.
      if (requested.backend === "none") {
        return { backend: "none", refused: false };
      }

      if (capabilities.availableIsolationBackends.includes(requested.backend)) {
        return { backend: requested.backend, refused: false };
      }

      // Never downgrade silently: an unavailable backend is refused whether or not `required` is set.
      return {
        backend: requested.backend,
        refused: true,
        reason: `Required isolation backend "${requested.backend}" is unavailable on this host.`,
      };
    },

    aggregateRestrictivePolicy(sessions) {
      const denyWritesSession = sessions.find((s) => s.permissionMode === "deny-writes");
      if (denyWritesSession !== undefined) {
        return {
          blocksNewLaunches: true,
          reason: "A connected session is in deny-writes mode; it suppresses new launches while attached.",
        };
      }
      return { blocksNewLaunches: false };
    },
  };
}
