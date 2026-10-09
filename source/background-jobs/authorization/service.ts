/**
 * T08 — Shared authorization and recurring consent service.
 *
 * Per the module-boundary note in types.ts: "authorization.ts consumes
 * storage + launch-spec, never imports coordinator" and per subtasks.md §4:
 * "authorization consumes policy/session snapshots rather than the
 * coordinator instance." This module never reads live application/session
 * state itself — every decision is a pure function of its arguments plus
 * the on-disk grant store it owns. No live coordinator is constructed or
 * imported here (none exists yet; T14 is the coordinator owner).
 */
import { randomUUID } from "node:crypto";

import type {
  AuthorizationDecision,
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
    opts?: { headless?: boolean },
  ): Promise<AuthorizationDecision>;

  /** Mints+persists a grant unconditionally; used after a human says yes in 'ask' mode. */
  recordExplicitApproval(action: GrantAction, spec: ConsentRelevantSpec): Promise<Grant>;

  /** Re-checks a previously-granted approval against the current spec before dispatch. */
  revalidateBeforeDispatch(grantId: GrantId, spec: ConsentRelevantSpec): Promise<AuthorizationDecision>;

  /**
   * Per solution.md §4: "Revocation blocks future launches; it does not
   * silently terminate existing work." This method MUST NOT attempt to stop
   * any running job — that is deliberately out of scope here; it is the
   * coordinator/supervisor's responsibility, triggered by a separate,
   * explicitly authorized `stop` action.
   */
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

      // (a) Headless gate is checked BEFORE permissionMode, so auto-accept
      // can never bypass "absent a handler is not consent" (solution.md §4).
      if (opts?.headless && !isHeadlessActionApproved(action, session)) {
        return {
          allowed: false,
          reason: "Headless execution requires an explicit applicable grant; none is present.",
        };
      }

      // (b) deny-writes blocks new launches (start/schedule-create) but
      // never stop/cleanup/schedule-revoke — see policy.ts for rationale.
      if (isBlockedByDenyWrites(action) && session.permissionMode === "deny-writes") {
        return { allowed: false, reason: "deny-writes permission mode blocks this action." };
      }

      const specHash = hashLaunchSpecForConsent(spec);

      // (c) Reuse an existing, still-active grant for this exact spec+action.
      const existing = await grantStore.findActiveBySpecHash(action, specHash);
      if (existing !== undefined) {
        return { allowed: true, reason: "Existing grant covers this exact spec.", grant: existing };
      }

      // (d) auto-accept mints a fresh grant on demand.
      if (session.permissionMode === "auto-accept") {
        const grant = mintGrant(action, specHash);
        await grantStore.put(grant);
        return { allowed: true, reason: "auto-accept permission mode.", grant };
      }

      // Confirm only the normalized, consent-relevant specification. The
      // callback is supplied by the host, not by the model/tool arguments.
      if (session.permissionMode === "ask" && !opts?.headless && session.confirmBackgroundAction) {
        const approvedSpec = structuredClone(spec);
        let onAbort: (() => void) | undefined;
        try {
          const cancelled = new Promise<boolean>((resolve) => {
            onAbort = () => resolve(false);
            session.signal?.addEventListener("abort", onAbort, { once: true });
            if (session.signal?.aborted) resolve(false);
          });
          const accepted = await Promise.race([
            session.confirmBackgroundAction(action, structuredClone(approvedSpec)),
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

      // (e) 'ask' mode with no existing grant: the caller (T14/T16) must
      // prompt a human and then call recordExplicitApproval() on consent.
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
      // Deliberately does not touch job/supervisor state — see interface doc.
      await grantStore.revoke(grantId);
    },

    resolveIsolation(requested, capabilities) {
      // Per solution.md §4: "Explicitly approved unrestricted execution is a
      // separate mode; never downgrade silently." backend:'none' is a
      // distinct, already-approved consent — not an error and not a
      // fallback target for anything else.
      if (requested.backend === "none") {
        return { backend: "none", refused: false };
      }

      if (capabilities.availableIsolationBackends.includes(requested.backend)) {
        return { backend: requested.backend, refused: false };
      }

      // Per solution.md §4: "Determine the actual isolation backend before
      // approval. Required isolation unavailable means refusal... never
      // downgrade silently." There is deliberately no silent-fallback path
      // here for the non-required case either: whether or not `required` is
      // set, an unavailable non-'none' backend is refused. The *only* way to
      // get unrestricted execution is to explicitly request backend:'none',
      // which is its own, separately-approved consent (handled above) — not
      // an automatic fallback chosen by this function.
      return {
        backend: requested.backend,
        refused: true,
        reason: `Required isolation backend "${requested.backend}" is unavailable on this host.`,
      };
    },

    aggregateRestrictivePolicy(sessions) {
      // Per solution.md §11: "Any connected deny-writes session suppresses
      // process-schedule launches while attached; combine other
      // restrictions conservatively."
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
