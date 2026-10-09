/**
 * T08 — Deterministic hashing of a launch specification for consent binding.
 *
 * Per solution.md §4: "Bind consent to that specification and revalidate
 * before dispatch. Material changes require renewed approval... irrelevant
 * request fields cannot widen a grant." Consent binds to the *reusable
 * shape* of a launch spec, not to one specific request instance, so
 * `requestId` and `createdAt` are excluded from the hashed input — that
 * exclusion is enforced at the type level via `Omit<LaunchSpec, 'requestId'
 * | 'createdAt'>` on every function in this module.
 *
 * Everything else is material and included: invocation, cwd, env (names
 * *and* values — a changed env value is a material change even if names are
 * unchanged), credentialRefs (names), isolation, ownershipScope, limits,
 * recurrence and headless.
 */
import { createHash } from "node:crypto";

import type { LaunchSpec } from "../types.js";

export type ConsentRelevantSpec = Omit<LaunchSpec, "requestId" | "createdAt">;

/**
 * Recursively sort object keys so logically-identical objects hash
 * identically regardless of property insertion order. Plain
 * `JSON.stringify` does not guarantee stable key ordering across different
 * construction paths (e.g. object literal vs. spread vs. assignment order),
 * so this helper is required rather than relying on engine behavior.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON serialization with recursively sorted object keys. */
export function deterministicStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Hash everything about a launch spec that materially affects what the user
 * is consenting to, excluding `requestId`/`createdAt` (enforced by the
 * `ConsentRelevantSpec` type). Two specs with the same consent-relevant
 * fields hash identically; any difference in a material field changes the
 * hash.
 */
export function hashLaunchSpecForConsent(spec: ConsentRelevantSpec): string {
  const material = {
    invocation: spec.invocation,
    cwd: spec.cwd,
    env: spec.env,
    credentialRefs: spec.credentialRefs,
    isolation: spec.isolation,
    ownershipScope: spec.ownershipScope,
    limits: spec.limits,
    recurrence: spec.recurrence,
    headless: spec.headless,
  };
  return createHash("sha256").update(deterministicStringify(material)).digest("hex");
}
