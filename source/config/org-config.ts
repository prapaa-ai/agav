import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgavConfig, PermissionMode } from "./config.js";

/**
 * Organization-managed configuration ("org tier").
 *
 * An administrator ships a policy that takes precedence over the user's global
 * config, project config, AND environment variables — the user cannot loosen it.
 * This mirrors Claude Code's managed settings and Codex's managed_config.toml:
 * IT places a file (via MDM or disk) and the CLI enforces it.
 *
 * The policy object here is deliberately *source-agnostic*: today it is read
 * from a file/env, but a future `agav login` can hand the exact same shape back
 * from the control plane and reuse `applyOrgConfig` unchanged. Login is just
 * another delivery mechanism for this same enforcement layer.
 */

/** Env var naming the org policy file path. Highest-priority source. */
const ORG_CONFIG_ENV = "AGAV_ORG_CONFIG";

/**
 * Known system paths checked when the env var is unset, in order. These match
 * the "managed file on disk" convention IT/MDM can write to.
 */
function systemOrgConfigPaths(): string[] {
  if (process.platform === "win32") {
    const programData = process.env["ProgramData"] || "C:\\ProgramData";
    return [join(programData, "Agav", "org-config.json")];
  }
  if (process.platform === "darwin") {
    return [
      "/Library/Application Support/Agav/org-config.json",
      "/etc/agav/org-config.json",
    ];
  }
  return ["/etc/agav/org-config.json"];
}

/**
 * The subset of config keys an org policy may enforce. Intentionally narrow:
 * security- and routing-sensitive keys, mirroring PROJECT_CONFIG_DENY but in
 * the opposite direction — these are the keys the org *does* get to pin.
 *
 * `controlPlane` is the seed address a future login flow starts from; putting
 * it here lets IT ship it the same way as the rest of the policy.
 */
export interface OrgConfig {
  /** Pin the provider; users cannot switch away from it. */
  provider?: AgavConfig["provider"];
  /** Pin the model. */
  model?: string;
  /** Pin the OpenAI-compatible gateway base URL. */
  openaiBaseURL?: string;
  /** Pin extra gateway headers (auth/routing). */
  openaiHeaders?: Record<string, string>;
  /** Permission floor: the loosest mode the user is allowed. */
  permissionMode?: PermissionMode;
  /** Models the user is allowed to select. Empty/undefined means "no restriction". */
  allowedModels?: string[];
  /** Providers the user is allowed to use. Empty/undefined means "no restriction". */
  allowedProviders?: AgavConfig["provider"][];
  /** Tool allowlist the org forces (merged with, not replaced by, user allowlist). */
  allowedTools?: string[];
  /** Control-plane address — the seed a future `agav login` discovers from. */
  controlPlane?: string;
}

/** Order of restrictiveness for permissionMode, strictest first. */
const PERMISSION_STRICTNESS: PermissionMode[] = ["deny-writes", "ask", "auto-accept"];

/** Narrow an unknown value to a string[] (dropping it entirely if malformed). */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Validate and coerce an untrusted policy object into a safe OrgConfig. Guards
 * the enforcement path against a bad file or a malformed control-plane
 * `/session` response: without it a value like `{"allowedTools":{"length":1}}`
 * would be cast to OrgConfig, then crash every later startup inside
 * `applyOrgConfig` (e.g. `TypeError: org.allowedTools is not iterable`) and
 * poison the persistent cache.
 *
 * Fail-closed on a structurally wrong known field (e.g. a restriction list that
 * is not an array): a *security* policy must not be silently weakened by dropping
 * a malformed restriction, so the whole policy is rejected (undefined) and any
 * existing valid cache is preserved. Wrong element types inside a correct
 * container are filtered. Unknown keys and a scalar field of the wrong type are
 * ignored. Returns undefined for a non-object input.
 *
 * This is malformed-input hardening, not an assumption that a trusted source is
 * adversarial.
 */
export function sanitizeOrgConfig(input: unknown): OrgConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const out: OrgConfig = {};

  if (typeof raw.provider === "string") out.provider = raw.provider as OrgConfig["provider"];
  if (typeof raw.model === "string") out.model = raw.model;
  if (typeof raw.openaiBaseURL === "string") out.openaiBaseURL = raw.openaiBaseURL;
  if (raw.openaiHeaders !== undefined) {
    if (typeof raw.openaiHeaders !== "object" || Array.isArray(raw.openaiHeaders)) return undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.openaiHeaders as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value;
    }
    out.openaiHeaders = headers;
  }
  if (raw.permissionMode !== undefined) {
    if (raw.permissionMode !== "deny-writes" && raw.permissionMode !== "ask" && raw.permissionMode !== "auto-accept") {
      return undefined;
    }
    out.permissionMode = raw.permissionMode;
  }
  // Restriction lists are security-critical: a wrong container type fails closed.
  if (raw.allowedModels !== undefined) {
    if (!Array.isArray(raw.allowedModels)) return undefined;
    out.allowedModels = asStringArray(raw.allowedModels)!;
  }
  if (raw.allowedProviders !== undefined) {
    if (!Array.isArray(raw.allowedProviders)) return undefined;
    out.allowedProviders = asStringArray(raw.allowedProviders) as OrgConfig["allowedProviders"];
  }
  if (raw.allowedTools !== undefined) {
    if (!Array.isArray(raw.allowedTools)) return undefined;
    out.allowedTools = asStringArray(raw.allowedTools)!;
  }
  if (typeof raw.controlPlane === "string") out.controlPlane = raw.controlPlane;

  return out;
}

/** True when `candidate` is at least as strict as `floor`. */
function isAtLeastAsStrict(candidate: PermissionMode, floor: PermissionMode): boolean {
  return PERMISSION_STRICTNESS.indexOf(candidate) <= PERMISSION_STRICTNESS.indexOf(floor);
}

/**
 * Read the org policy from the highest-priority available source, in order:
 *
 *   1. admin-shipped file — `AGAV_ORG_CONFIG` env path, else a known system path
 *   2. cached enrolled policy — written by authenticated enrollment (`agav login`)
 *
 * An admin-shipped file outranks an enrolled policy: a file placed by IT/MDM on
 * the machine is a stronger local mandate than a per-user enrollment. Returns
 * undefined when no org policy is present (the common, non-enterprise case) and
 * never throws — a missing or unreadable policy must not break a normal startup.
 */
export async function loadOrgConfig(): Promise<OrgConfig | undefined> {
  const fromFile = await loadOrgConfigFromFile();
  if (fromFile) return fromFile;

  // Fall back to a policy delivered by authenticated enrollment.
  const { loadEnrolledPolicy } = await import("./enterprise-policy-store.js");
  const enrolled = await loadEnrolledPolicy();
  return enrolled ? sanitizeOrgConfig(enrolled.policy) : undefined;
}

/** Load the org policy from the admin-shipped file source only. */
async function loadOrgConfigFromFile(): Promise<OrgConfig | undefined> {
  const candidates: string[] = [];
  const fromEnv = process.env[ORG_CONFIG_ENV];
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(...systemOrgConfigPaths());

  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf-8");
      const sanitized = sanitizeOrgConfig(JSON.parse(raw));
      if (sanitized) return sanitized;
    } catch {
      // Missing/unreadable/invalid file at this path: try the next candidate.
    }
  }
  return undefined;
}

/**
 * Apply the org policy on top of an already-resolved config, enforcing the
 * floor. Mutates and returns `merged`. The enforcement rules:
 *
 * - `provider`/`model`/`openaiBaseURL`/`openaiHeaders`/`controlPlane` are hard
 *   pins: the org value wins outright.
 * - `permissionMode` is a floor: keep the user's choice only if it is at least
 *   as strict as the org floor; otherwise clamp to the floor.
 * - `allowedTools` is additive: the org's required tools are merged in.
 * - `allowedModels`/`allowedProviders` restrict selection; enforcement that a
 *   *chosen* model/provider is in-policy happens at provider-selection time, but
 *   we expose them on the config so that layer can read them.
 */
export function applyOrgConfig(merged: AgavConfig, org: OrgConfig | undefined): AgavConfig {
  if (!org) return merged;

  if (org.provider !== undefined) {
    merged.provider = org.provider;
    // Record the pin so later startup routing / interactive changes can't drop it.
    merged.orgManagedProvider = org.provider;
  }
  if (org.model !== undefined) {
    merged.model = org.model;
    merged.orgManagedModel = org.model;
  }
  if (org.openaiBaseURL !== undefined) merged.openaiBaseURL = org.openaiBaseURL;
  if (org.openaiHeaders !== undefined) merged.openaiHeaders = org.openaiHeaders;

  if (org.permissionMode !== undefined) {
    // Floor: never let the effective mode be looser than the org requires.
    // Record it so later widening (CLI -y, interactive "Always", child agents)
    // can be clamped back to this floor.
    merged.orgPermissionFloor = org.permissionMode;
    if (!isAtLeastAsStrict(merged.permissionMode, org.permissionMode)) {
      merged.permissionMode = org.permissionMode;
    }
  }

  if (org.allowedTools && org.allowedTools.length > 0) {
    merged.allowedTools = [
      ...org.allowedTools,
      ...(merged.allowedTools ?? []).filter((t) => !org.allowedTools!.includes(t)),
    ];
  }

  // Surface selection restrictions for the provider/model-selection layer to read.
  if (org.allowedModels !== undefined) merged.orgAllowedModels = org.allowedModels;
  if (org.allowedProviders !== undefined) merged.orgAllowedProviders = org.allowedProviders;
  if (org.controlPlane !== undefined) merged.controlPlane = org.controlPlane;

  // Convenience: when the org allows exactly one provider (or model) and has not
  // already hard-pinned it, adopt it as the effective value. With only one choice
  // there is nothing to preserve, so this spares the user from passing
  // --provider/--model just to match a single-option allowlist. A multi-option
  // allowlist is left untouched — the user's selection is enforced later.
  if (org.provider === undefined && org.allowedProviders?.length === 1) {
    merged.provider = org.allowedProviders[0]!;
  }
  if (org.model === undefined && org.allowedModels?.length === 1) {
    merged.model = org.allowedModels[0]!;
  }

  return merged;
}

/**
 * Clamp a requested permission mode against the org floor, if any. Returns the
 * requested mode when it is at least as strict as the floor, otherwise the floor.
 * Call this wherever permissions widen after config load — CLI `-y`, interactive
 * "Always", and child-agent modes — so the managed floor always survives.
 */
export function clampPermissionMode(
  requested: PermissionMode,
  floor: PermissionMode | undefined,
): PermissionMode {
  if (!floor) return requested;
  return isAtLeastAsStrict(requested, floor) ? requested : floor;
}

/**
 * Re-assert the org's hard provider/model pins on a resolved config, returning an
 * error message when a later selection (CLI flags, resumed/recent session,
 * model-catalog routing) replaced a managed pin with a different value. The pins
 * are mandatory and cannot be loosened; this is checked after startup routing and
 * at every selection boundary, not only via the allowlist path.
 */
export function managedPinError(config: AgavConfig): string | null {
  if (config.orgManagedProvider !== undefined && config.provider !== config.orgManagedProvider) {
    return `Provider ${JSON.stringify(config.provider)} is not permitted by your organization's policy. ` +
      `Your organization requires provider ${JSON.stringify(config.orgManagedProvider)}.`;
  }
  if (config.orgManagedModel !== undefined && config.model !== config.orgManagedModel) {
    return `Model ${JSON.stringify(config.model)} is not permitted by your organization's policy. ` +
      `Your organization requires model ${JSON.stringify(config.orgManagedModel)}.`;
  }
  return null;
}

export {
  ORG_CONFIG_ENV,
  systemOrgConfigPaths,
  isAtLeastAsStrict,
};
