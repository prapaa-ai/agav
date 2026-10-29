import { secureURL } from "../enterprise/secure-url.js";
import { AccountError } from "./types.js";

/**
 * Client for the Agav account service's browser-authorization (device-grant)
 * endpoints: start a request, poll for the result, and acknowledge receipt.
 * Mirrors docs/cli-browser-authorization.md. Secrets (device code, API key) are
 * never logged and never placed in a URL.
 */

/** Per-request network deadline for each individual call (connect + body). */
const CALL_TIMEOUT_MS = 15_000;

/** What `POST /api/cli-auth/start` returns to the CLI. */
export interface AuthorizationRequest {
  /** Secret, CLI-only. Used to poll and acknowledge. */
  deviceCode: string;
  /** Short human code the user compares in the browser (e.g. "ABCD-2345"). */
  userCode: string;
  /** The page to open; the "complete" variant pre-fills the code. */
  verificationUrl: string;
  verificationUrlComplete: string;
  /** Seconds until the request expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

/** A single poll outcome. */
export type PollResult =
  | { status: "pending" }
  | { status: "slow_down"; retryAfterMs?: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error" }
  | { status: "approved"; key: string };

function endpoint(accountService: string, path: string): URL {
  const base = secureURL(accountService);
  return new URL(path, base.href.endsWith("/") ? base.href : `${base.href}/`);
}

/**
 * Combine a caller signal with a per-call timeout. On timeout the signal aborts
 * with an AccountError so callers can distinguish it from a user cancellation.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new AccountError("The Agav account service did not respond in time.")), ms);
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
}

/** POST JSON to a cli-auth endpoint, honouring redirect:error and the timeout. */
async function postJson(
  accountService: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; data: unknown }> {
  const url = endpoint(accountService, path);
  const { signal: effectiveSignal, cleanup } = withTimeout(signal, CALL_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url.href, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: effectiveSignal,
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        const reason = effectiveSignal.reason;
        throw reason instanceof AccountError ? reason : (error as Error);
      }
      throw new AccountError(
        `Could not reach the Agav account service at ${url.origin}. Check your connection and try again.`,
        { cause: error },
      );
    }
    let data: unknown = undefined;
    try { data = await response.json(); } catch { /* some error statuses may omit a body */ }
    return { status: response.status, data };
  } finally {
    cleanup();
  }
}

/** Begin a browser-authorization request. */
export async function startAuthorization(accountService: string, signal?: AbortSignal): Promise<AuthorizationRequest> {
  const { status, data } = await postJson(accountService, "api/cli-auth/start", {}, signal);
  if (status === 429) throw new AccountError("Too many sign-in attempts right now. Please wait a minute and try again.");
  if (status !== 201 && status !== 200) throw new AccountError("Could not start browser sign-in. Please try again.");
  const obj = (data ?? {}) as Record<string, unknown>;
  const deviceCode = typeof obj.deviceCode === "string" ? obj.deviceCode : undefined;
  const userCode = typeof obj.userCode === "string" ? obj.userCode : undefined;
  const verificationUrl = typeof obj.verificationUrl === "string" ? obj.verificationUrl : undefined;
  const verificationUrlComplete = typeof obj.verificationUrlComplete === "string" ? obj.verificationUrlComplete : verificationUrl;
  if (!deviceCode || !userCode || !verificationUrl || !verificationUrlComplete) {
    throw new AccountError("The Agav account service returned an incomplete sign-in request.");
  }
  // Validate the verification URLs are same-origin as the account service and
  // HTTPS (loopback allowed in dev) — never open an attacker-influenced URL.
  const base = secureURL(accountService).origin;
  for (const u of [verificationUrl, verificationUrlComplete]) {
    let parsed: URL;
    try { parsed = secureURL(u); } catch { throw new AccountError("The Agav account service returned an unsafe verification URL."); }
    if (parsed.origin !== base) throw new AccountError("The Agav account service returned a mismatched verification URL.");
  }
  const interval = typeof obj.interval === "number" && obj.interval > 0 ? obj.interval : 2;
  const expiresIn = typeof obj.expiresIn === "number" && obj.expiresIn > 0 ? obj.expiresIn : 600;
  return { deviceCode, userCode, verificationUrl, verificationUrlComplete, expiresIn, interval };
}

/** Poll once for the result of a request. */
export async function pollToken(accountService: string, deviceCode: string, signal?: AbortSignal): Promise<PollResult> {
  const { status, data } = await postJson(accountService, "api/cli-auth/token", { deviceCode }, signal);
  const s = typeof (data as Record<string, unknown>)?.status === "string" ? (data as Record<string, string>).status : undefined;
  if (status === 429) return { status: "slow_down" };
  if (status === 503) return { status: "error" };
  if (status === 400) return s === "denied" ? { status: "denied" } : { status: "expired" };
  if (status === 200) {
    if (s === "approved") {
      const key = (data as Record<string, unknown>).key;
      if (typeof key === "string" && key.length > 0) return { status: "approved", key };
      return { status: "error" };
    }
    // "acknowledged" means a previous poll already delivered + we already acked;
    // treat it as expired here (the caller uses the locally-stored key instead).
    if (s === "acknowledged") return { status: "expired" };
    if (s === "slow_down") return { status: "slow_down" };
    return { status: "pending" };
  }
  return { status: "error" };
}

/**
 * Acknowledge durable receipt of the key. Returns true on success. Safe to
 * retry before expiry if a prior ack response was lost. Never throws for a
 * normal failure — the caller decides whether to retry.
 */
export async function acknowledge(accountService: string, deviceCode: string, key: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const { status, data } = await postJson(accountService, "api/cli-auth/ack", { deviceCode, key }, signal);
    return status === 200 && (data as Record<string, unknown>)?.status === "acknowledged";
  } catch {
    return false;
  }
}

export { endpoint as browserAuthEndpoint };
