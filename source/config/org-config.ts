import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgavConfig, PermissionMode } from "./config.js";
import { defaultModelForProvider } from "./provider-defaults.js";

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
  /** SIEM sink URL for audit events (sign-in/out). Admin-shipped; see audit.ts. */
  auditSink?: string;
}

/** Order of restrictiveness for permissionMode, strictest first. */
const PERMISSION_STRICTNESS: PermissionMode[] = ["deny-writes", "ask", "auto-accept"];

/**
 * Providers the org policy may name in `provider` / `allowedProviders`. Kept in
 * sync with AgavConfig["provider"]; defined locally to avoid importing from
 * config/startup (which import this module). A compile-time check below ensures
 * this set exactly matches the union.
 */
const VALID_PROVIDERS = [
  "anthropic", "openai", "openrouter", "nvidia", "deepseek", "ollama", "gemini", "vertex-ai",
] as const;
type ValidProvider = (typeof VALID_PROVIDERS)[number];
// Fails to compile if AgavConfig["provider"] and VALID_PROVIDERS drift apart.
const _providerExhaustiveness: Record<AgavConfig["provider"], true> = {
  anthropic: true, openai: true, openrouter: true, nvidia: true,
  deepseek: true, ollama: true, gemini: true, "vertex-ai": true,
};
void _providerExhaustiveness;

function isValidProvider(value: unknown): value is ValidProvider {
  return typeof value === "string" && (VALID_PROVIDERS as readonly string[]).includes(value);
}

/** Error for a present-but-invalid org policy (file or enrollment). */
export class OrgConfigError extends Error {}

/**
 * Validate an untrusted policy object into a safe OrgConfig, or throw
 * OrgConfigError when a present policy is invalid. This is the strict core used
 * by both the file loader (which surfaces the error) and sanitizeOrgConfig
 * (which converts a throw into undefined). Guards the enforcement path against a
 * bad file or a malformed control-plane `/session` response: without it a value
 * like `{"allowedTools":{"length":1}}` would be cast to OrgConfig, then crash
 * every later startup inside `applyOrgConfig` and poison the persistent cache.
 *
 * Fail-closed, never fail-open: a security policy must not be silently weakened.
 *   - A restriction list (allowedModels/allowedProviders/allowedTools) must be an
 *     array of non-empty strings; a wrong container, a non-string/empty member,
 *     or an empty-after-parse list is rejected (an empty list reads as "no
 *     restriction", so turning a malformed one into [] would loosen policy).
 *   - `provider` and every `allowedProviders` member must be a known provider.
 *   - `permissionMode` must be a valid mode.
 *   - A scalar field of the wrong type and unknown keys are ignored.
 */
export function parseOrgConfig(input: unknown): OrgConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OrgConfigError("Organization policy must be a JSON object.");
  }
  const raw = input as Record<string, unknown>;
  const out: OrgConfig = {};

  if (raw.provider !== undefined) {
    if (!isValidProvider(raw.provider)) {
      throw new OrgConfigError(`Organization policy pins an unknown provider: ${JSON.stringify(raw.provider)}.`);
    }
    out.provider = raw.provider;
  }
  if (typeof raw.model === "string") out.model = raw.model;
  if (typeof raw.openaiBaseURL === "string") out.openaiBaseURL = raw.openaiBaseURL;
  if (raw.openaiHeaders !== undefined) {
    if (typeof raw.openaiHeaders !== "object" || Array.isArray(raw.openaiHeaders)) {
      throw new OrgConfigError("Organization policy openaiHeaders must be an object.");
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.openaiHeaders as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value;
    }
    out.openaiHeaders = headers;
  }
  if (raw.permissionMode !== undefined) {
    if (raw.permissionMode !== "deny-writes" && raw.permissionMode !== "ask" && raw.permissionMode !== "auto-accept") {
      throw new OrgConfigError(`Organization policy has an invalid permissionMode: ${JSON.stringify(raw.permissionMode)}.`);
    }
    out.permissionMode = raw.permissionMode;
  }
  if (raw.allowedModels !== undefined) {
    out.allowedModels = parseStringRestriction(raw.allowedModels, "allowedModels");
  }
  if (raw.allowedProviders !== undefined) {
    const providers = parseStringRestriction(raw.allowedProviders, "allowedProviders");
    for (const p of providers) {
      if (!isValidProvider(p)) {
        throw new OrgConfigError(`Organization policy allowedProviders contains an unknown provider: ${JSON.stringify(p)}.`);
      }
    }
    out.allowedProviders = providers as OrgConfig["allowedProviders"];
  }
  if (raw.allowedTools !== undefined) {
    out.allowedTools = parseStringRestriction(raw.allowedTools, "allowedTools");
  }
  if (typeof raw.controlPlane === "string") out.controlPlane = raw.controlPlane;
  if (typeof raw.auditSink === "string") out.auditSink = raw.auditSink;

  return out;
}

/**
 * Parse a restriction list: must be a non-empty array whose members are all
 * non-empty strings. Rejects anything that would collapse into an empty "no
 * restriction" list rather than silently loosening the policy.
 */
function parseStringRestriction(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OrgConfigError(`Organization policy ${field} must be a non-empty array of strings.`);
  }
  for (const member of value) {
    if (typeof member !== "string" || member.length === 0) {
      throw new OrgConfigError(`Organization policy ${field} must contain only non-empty strings.`);
    }
  }
  return value as string[];
}

/**
 * Validate a policy object, returning undefined when it is absent/non-object or
 * present-but-invalid. Used on the control-plane `/session` path, where a
 * rejected (malformed) response must leave any existing valid cache intact
 * rather than throwing through the caller.
 */
export function sanitizeOrgConfig(input: unknown): OrgConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    return parseOrgConfig(input);
  } catch (error) {
    if (error instanceof OrgConfigError) return undefined;
    throw error;
  }
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
  return (await loadOrgPolicy()).config;
}

/**
 * The resolved org policy plus the enrollment credential that accompanies it.
 *
 * `gatewayToken` is present only when the winning policy came from authenticated
 * enrollment (never from an admin-shipped file — a file source has no gateway
 * credential). It is injected as the provider's Authorization header so live
 * inference reaches the org gateway.
 */
export interface ResolvedOrgPolicy {
  config?: OrgConfig;
  gatewayToken?: string;
}

/**
 * Resolve the org policy and (for the enrollment source only) its gateway token,
 * applying the same precedence as `loadOrgConfig`: an admin-shipped file outranks
 * an enrolled policy. When the file source wins, no gateway token is returned,
 * since a file-delivered policy carries no enrollment credential.
 */
export async function loadOrgPolicy(): Promise<ResolvedOrgPolicy> {
  const fromFile = await loadOrgConfigFromFile();
  if (fromFile) return { config: fromFile };

  // Fall back to a policy delivered by authenticated enrollment.
  const { loadEnrolledPolicy } = await import("./enterprise-policy-store.js");
  const enrolled = await loadEnrolledPolicy();
  if (!enrolled) return {};
  return {
    config: sanitizeOrgConfig(enrolled.policy),
    gatewayToken: enrolled.gatewayToken,
  };
}

/**
 * Inject the enrollment gateway token as the OpenAI-compatible provider's
 * Authorization header, so live inference authenticates to the org gateway.
 *
 * Rules:
 *   - Only an enrollment-sourced token is injected (file policies have none).
 *   - **The token is bound to an explicit enrollment gateway URL.** It is injected
 *     only when the org *policy* pins `openaiBaseURL`. Without that, the user's
 *     own endpoint (e.g. api.openai.com) is left untouched — a gateway token must
 *     never be sent to an endpoint the org did not designate.
 *   - An Authorization header **pinned by the org policy** wins — explicit beats
 *     implicit — so an admin can override the scheme/value. A stale Authorization
 *     value merely inherited from the user's own config does NOT suppress the
 *     token; it is replaced, since the org gateway dictates authentication.
 *   - The token is injected regardless of `expiresAt`: the gateway is the
 *     authority on validity, and a stale token simply fails there, which is
 *     clearer than silently sending no credential.
 *
 * `org` is the org policy (the enrollment source of truth); `merged` is the fully
 * resolved config. Mutates and returns `merged`.
 */
export function applyGatewayToken(
  merged: AgavConfig,
  org: OrgConfig | undefined,
  gatewayToken: string | undefined,
): AgavConfig {
  // No token, or the org did not designate a gateway endpoint: do not inject.
  // Binding to the policy's own openaiBaseURL (not merged.openaiBaseURL) prevents
  // the token from authenticating against a user-configured endpoint.
  if (!gatewayToken || !org?.openaiBaseURL) return merged;

  // Only an Authorization header the ORG POLICY pinned is exempt. A value merely
  // inherited from the user's global/project config must not suppress the org
  // token — the gateway, not the user, dictates authentication here.
  const policyPinnedAuth = Object.keys(org.openaiHeaders ?? {}).some(
    (k) => k.toLowerCase() === "authorization",
  );

  const headers = { ...(merged.openaiHeaders ?? {}) };
  if (!policyPinnedAuth) {
    // Drop any user-sourced Authorization (any casing), then set the org token.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") delete headers[key];
    }
    headers["Authorization"] = `Bearer ${gatewayToken}`;
  }
  merged.openaiHeaders = headers;
  // The gateway token authenticates the OpenAI-compatible endpoint, so a personal
  // API key is not required for a gateway-only enrolled developer.
  merged.openaiGatewayAuth = true;
  return merged;
}

/**
 * Load the org policy from the admin-shipped file source only.
 *
 * Fail-closed: only a *genuinely absent* file (ENOENT) permits unmanaged startup
 * and lets the next candidate be tried. A present file that cannot be read
 * (permission/I/O error), does not parse as JSON, or parses but fails validation
 * is a present-but-invalid policy and throws OrgConfigError — a syntax error or a
 * locked managed file must never silently disable the admin's restrictions.
 */
async function loadOrgConfigFromFile(): Promise<OrgConfig | undefined> {
  const candidates: string[] = [];
  const fromEnv = process.env[ORG_CONFIG_ENV];
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(...systemOrgConfigPaths());

  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (error) {
      // Only a genuinely missing file is "absent" — try the next candidate.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      // A present-but-unreadable file (permissions, I/O) must not silently
      // disable enforcement.
      throw new OrgConfigError(
        `Organization policy at ${path} could not be read: ${(error as Error).message}`,
        { cause: error },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      // A present file with malformed JSON is present-but-invalid, not absent.
      throw new OrgConfigError(
        `Organization policy at ${path} is not valid JSON: ${(error as Error).message}`,
        { cause: error },
      );
    }
    // The file is present and parses: a validation failure also surfaces.
    return parseOrgConfig(json);
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
    const providerChanged = merged.provider !== org.provider;
    merged.provider = org.provider;
    // Record the pin so later startup routing / interactive changes can't drop it.
    merged.orgManagedProvider = org.provider;
    // Establish a compatible pair: when the pin changes the provider and the org
    // does not also pin a model, the carried model belonged to the old provider
    // (e.g. anthropic/claude-sonnet -> openai/claude-sonnet). Reset it to the
    // pinned provider's default so the pair is coherent rather than mismatched.
    if (providerChanged && org.model === undefined) {
      merged.model = defaultModelForProvider(org.provider);
    }
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
  if (org.auditSink !== undefined) merged.auditSink = org.auditSink;

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
