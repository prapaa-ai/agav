import { secureURL } from "../enterprise/secure-url.js";
import { AccountError, type AccountIdentity } from "./types.js";

/**
 * Client for the Agav consumer account service. Today it exposes a single call,
 * `whoami`, which validates an Agav API key and returns the account identity.
 * The account service brokers identity/subscription only; it is not the
 * inference path (that is the gateway, a later slice).
 */

/** Build an endpoint URL under the account-service base, validated and normalized. */
function accountEndpoint(accountService: string, path: string): URL {
  const base = secureURL(accountService);
  return new URL(path, base.href.endsWith("/") ? base.href : `${base.href}/`);
}

/** Default overall deadline for a whoami call (connect + body read). */
const WHOAMI_TIMEOUT_MS = 15_000;

/**
 * Combine an optional caller signal with a bounded timeout into one signal, so a
 * stalled connection or a stalled body read can never leave sign-in pending.
 * Returns the signal plus a cleanup to clear the timer.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new AccountError("The Agav account service did not respond in time.")), ms);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Validate an Agav API key against the account service and return the account
 * identity. Maps the whoami contract to typed results:
 *   200 -> AccountIdentity
 *   401 -> AccountError ("not a valid Agav API key")
 *   503 -> AccountError ("service unavailable") — a transient lookup failure the
 *          caller may retry; deliberately distinct from 401 so a good key is
 *          never reported as invalid on a server blip.
 *   other / network / malformed -> AccountError
 *
 * @param accountService base URL of the account service
 * @param apiKey         the Agav API key (agav_sk_...)
 * @param signal         optional abort signal (timeout / cancellation)
 */
export async function whoami(
  accountService: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<AccountIdentity> {
  const endpoint = accountEndpoint(accountService, "api/account/whoami");
  // Bound the whole call (connect AND body read) so a stall can't hang sign-in.
  const { signal: effectiveSignal, cleanup } = withTimeout(signal, WHOAMI_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint.href, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        redirect: "error",
        signal: effectiveSignal,
      });
    } catch (error) {
      // A caller-initiated abort propagates as-is; a timeout surfaces as the
      // AccountError we set as the abort reason.
      if ((error as Error)?.name === "AbortError") {
        const reason = effectiveSignal.reason;
        throw reason instanceof AccountError ? reason : (error as Error);
      }
      // Do NOT include the raw exception message: fetch's invalid-header /
      // invalid-URL errors echo the offending value (which contains the API key
      // in the Authorization header). Report only the origin we tried to reach.
      throw new AccountError(
        `Could not reach the Agav account service at ${endpoint.origin}. Check your connection and try again.`,
        { cause: error },
      );
    }

    if (response.status === 401) {
      await response.body?.cancel();
      throw new AccountError("That isn't a valid Agav API key (it may be wrong or revoked).");
    }
    if (response.status === 503) {
      await response.body?.cancel();
      throw new AccountError("The Agav account service is temporarily unavailable. Please try again.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccountError(`Agav account sign-in failed (HTTP ${response.status}).`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        const reason = effectiveSignal.reason;
        throw reason instanceof AccountError ? reason : (error as Error);
      }
      throw new AccountError("The Agav account service returned a non-JSON response.", { cause: error });
    }
    return parseIdentity(data);
  } finally {
    cleanup();
  }
}

/** Narrow and validate the whoami response into an AccountIdentity. */
function parseIdentity(data: unknown): AccountIdentity {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AccountError("The Agav account service returned a malformed response.");
  }
  const obj = data as Record<string, unknown>;
  const accountId = typeof obj.accountId === "string" ? obj.accountId : undefined;
  if (!accountId) {
    throw new AccountError("The Agav account service response is missing an account id.");
  }
  return {
    accountId,
    email: typeof obj.email === "string" ? obj.email : null,
    status: typeof obj.status === "string" ? obj.status : "unknown",
  };
}

export { accountEndpoint };
