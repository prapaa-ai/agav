import { secureURL } from "./secure-url.js";
import type { AuthFlow } from "./types.js";

/**
 * Audit → SIEM: emit admin/enrollment events for the enterprise control plane.
 *
 * Security-relevant actions on the CLI side (sign-in attempts, successes,
 * failures, and sign-out) are the events an organization wants in its SIEM for
 * detection and compliance. The control plane does its own server-side auditing
 * of `/session`; this module covers the *client* vantage point, which is the
 * only place that sees, for example, a login that never reached the control
 * plane (a browser that would not open, a cancelled device flow).
 *
 * Design constraints:
 *   - **Never block or break login.** Auditing is best-effort: a sink that is
 *     slow, unreachable, or misconfigured must not fail or delay `agav login`.
 *     Every emit is fire-and-forget with its own short timeout and swallows
 *     errors.
 *   - **No secrets in events.** An event carries the action, outcome, flow,
 *     control-plane origin, subject (when known), and a reason string — never an
 *     id_token, gateway token, authorization code, or PKCE verifier.
 *   - **Opt-in sink.** Events are dropped unless a sink is configured, so the
 *     non-enterprise path emits nothing. The sink is an HTTPS endpoint the admin
 *     ships (via env or org policy); it receives one JSON event per request.
 */

/** The audit action being recorded. */
export type AuditAction =
  | "login.attempt"
  | "login.success"
  | "login.failure"
  | "logout";

/**
 * Allowlisted, secret-free failure reason codes.
 *
 * **Never put a raw error message in an audit event.** Some auth errors carry
 * server response content — e.g. a malformed device-authorization body surfaces
 * as a JSON parse error whose message echoes the offending bytes, which could
 * include a secret. The event must only ever carry one of these fixed codes; the
 * full exception is retained for *local* reporting (stderr) only. Add codes here
 * as needed rather than widening to free-form strings.
 */
export type AuditReason =
  /** The user or a signal (Ctrl-C) cancelled the login. */
  | "cancelled"
  /** The flow exceeded its deadline. */
  | "timed_out"
  /** The control plane / IdP rejected the sign-in (not authorized / no seat). */
  | "unauthorized"
  /** A network/transport problem reaching the control plane or IdP. */
  | "network_error"
  /** No usable local browser for an interactive flow. */
  | "browser_unavailable"
  /** Enterprise sign-in is not fully configured for the org. */
  | "not_configured"
  /** No OIDC token source available for the CI flow. */
  | "no_token_source"
  /** A protocol-level failure (bad/missing token, malformed response, etc.). */
  | "protocol_error"
  /** Any other failure — details go to stderr, never to the event. */
  | "error";

/** A structured, secret-free audit event emitted toward a SIEM sink. */
export interface AuditEvent {
  /** What happened. */
  action: AuditAction;
  /** Which login flow was involved, when applicable. */
  flow?: AuthFlow;
  /** Control-plane origin the action targeted (never the full URL with path). */
  controlPlane?: string;
  /** The subject the session was issued for, when known (login.success). */
  subject?: string;
  /** An allowlisted, non-sensitive reason code (login.failure). Never a raw message. */
  reason?: AuditReason;
  /** ISO-8601 timestamp the event was created on the client. */
  at: string;
  /** Stable source tag so the SIEM can filter Agav CLI events. */
  source: "agav-cli";
}

/**
 * Map an arbitrary login error to an allowlisted, secret-free reason code. The
 * mapping keys only off the error's *shape* and a small set of stable substrings
 * the CLI itself emits — never off server-supplied content — so a reason code can
 * never carry a leaked secret. Anything unrecognized becomes the generic "error".
 */
export function classifyFailureReason(error: unknown): AuditReason {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || /\bcancell?ed\b/i.test(message)) return "cancelled";
  if (/timed out|timeout/i.test(message)) return "timed_out";
  if (/not authorized|no seat|rejected the sign-in/i.test(message)) return "unauthorized";
  if (/could not reach|request failed|ECONN|ENOTFOUND|network/i.test(message)) return "network_error";
  if (/could not open a browser|requires a browser/i.test(message)) return "browser_unavailable";
  if (/isn't fully set up|not .*set up|auth-config/i.test(message)) return "not_configured";
  if (/no oidc token|token source|token endpoint/i.test(message)) return "no_token_source";
  if (/id_token|non-json|malformed|HTTP \d{3}|does not support/i.test(message)) return "protocol_error";
  return "error";
}

/** Env var naming the SIEM webhook endpoint. Highest-priority sink source. */
const AUDIT_SINK_ENV = "AGAV_AUDIT_SINK";

/** How long to wait on a sink before giving up (audit must never stall login). */
const SINK_TIMEOUT_MS = 2000;

export interface AuditSinkOptions {
  /** Explicit sink URL (e.g. from org policy). Overrides the env var when set. */
  sink?: string;
  /** Env accessor, injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the configured SIEM sink URL, or undefined when none is set.
 * Precedence: explicit option (org policy) > AGAV_AUDIT_SINK env var. An
 * insecure or malformed sink is treated as *not configured* (returns undefined)
 * rather than throwing, so a bad sink can never break login — it only means no
 * events are shipped, which is the fail-safe for best-effort auditing.
 */
export function resolveAuditSink(options: AuditSinkOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const candidate = options.sink || env[AUDIT_SINK_ENV];
  if (!candidate) return undefined;
  try {
    return secureURL(candidate).href;
  } catch {
    return undefined;
  }
}

/** Build a secret-free audit event, stamping the time and source. */
export function buildAuditEvent(
  fields: Omit<AuditEvent, "at" | "source">,
): AuditEvent {
  return { ...fields, at: new Date().toISOString(), source: "agav-cli" };
}

/**
 * Ship one audit event to the configured SIEM sink, best-effort.
 *
 * Returns true when the event was delivered (2xx), false otherwise — including
 * when no sink is configured, the sink is unreachable, times out, or returns a
 * non-2xx status. Never throws and never rejects: callers may `await` it without
 * guarding, and a broken sink cannot surface as a login error.
 *
 * `fetchImpl` is injectable for testing; it defaults to the global `fetch`.
 */
export async function emitAuditEvent(
  event: AuditEvent,
  options: AuditSinkOptions & { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const sink = resolveAuditSink(options);
  if (!sink) return false;

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SINK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(sink, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(event),
      redirect: "error",
      signal: controller.signal,
    });
    // Drain the body so the socket can be reused / closed promptly.
    await response.body?.cancel();
    return response.ok;
  } catch {
    // Best-effort: any failure (network, timeout, abort, bad sink) is swallowed.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience: build and emit an audit event in one call, best-effort. Returns
 * the delivery outcome (see emitAuditEvent). Used by the login/logout CLI to
 * record enrollment actions without threading the timestamp/source boilerplate.
 */
export async function recordAuditEvent(
  fields: Omit<AuditEvent, "at" | "source">,
  options: AuditSinkOptions & { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  return emitAuditEvent(buildAuditEvent(fields), options);
}

export { AUDIT_SINK_ENV, SINK_TIMEOUT_MS };
