/**
 * T12 — PID-reuse guard.
 *
 * This file is intentionally thin. All real liveness-verification logic
 * lives in the `PlatformAdapter.verifyAlive()` implementations (T02/T03/T04)
 * — this wrapper exists purely so that every recovery-layer call site goes
 * through one named, documented function instead of scattering raw
 * `adapter.verifyAlive(identity)` calls throughout `recovery/*`.
 *
 * Why this matters (solution.md §6): "PID existence alone is never
 * sufficient to authorize a signal; PID reuse can otherwise kill unrelated
 * work." A bare PID number is NOT a safe proof of identity across time —
 * operating systems recycle PIDs, so a number that used to belong to our
 * supervisor can later belong to a completely unrelated process. The only
 * safe way to re-identify "is this still the same process we launched" is
 * to combine the PID with the best-available creation/boot identity
 * (`ProcessIdentity.creationIdentity`) and let the platform adapter compare
 * both — never to treat PID existence by itself as proof of continuity.
 *
 * Recovery code must call `isSameLiveProcess` rather than
 * `platformAdapter.verifyAlive` directly, so that:
 *   - this documentation/rationale is discoverable at the call site, and
 *   - if a stronger recovery-side check (e.g. additional corroborating
 *     evidence) is ever added, there is exactly one place to add it.
 */
import type { PlatformAdapter, ProcessIdentity } from "../types.js";

/**
 * True only when there is positive evidence that `identity` still refers to
 * the same live process the caller originally launched (not merely that
 * *some* process with that PID currently exists). Delegates entirely to
 * `platformAdapter.verifyAlive`, which is the single source of truth for
 * PID-reuse-safe liveness checks per the frozen `PlatformAdapter` contract.
 */
export async function isSameLiveProcess(identity: ProcessIdentity, platformAdapter: PlatformAdapter): Promise<boolean> {
  return platformAdapter.verifyAlive(identity);
}
