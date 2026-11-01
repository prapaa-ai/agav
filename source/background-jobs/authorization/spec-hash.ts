// Consent binds to the reusable shape of a spec: requestId and createdAt are excluded.
// Everything else is material, including env values.
import { createHash } from "node:crypto";

import type { LaunchSpec } from "../types.js";

export type ConsentRelevantSpec = Omit<LaunchSpec, "requestId" | "createdAt">;

/** JSON.stringify key order depends on construction path, so sort keys for a stable hash. */
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

export function hashLaunchSpecForConsent(spec: ConsentRelevantSpec): string {
  const material = {
    invocation: spec.invocation,
    cwd: spec.cwd,
    env: spec.env,
    // Names only; absent for specs without inherited variables so their hashes are unchanged.
    ...(spec.envInherit !== undefined && spec.envInherit.length > 0 ? { envInherit: spec.envInherit } : {}),
    credentialRefs: spec.credentialRefs,
    isolation: spec.isolation,
    ownershipScope: spec.ownershipScope,
    limits: spec.limits,
    recurrence: spec.recurrence,
    headless: spec.headless,
  };
  return createHash("sha256").update(deterministicStringify(material)).digest("hex");
}
