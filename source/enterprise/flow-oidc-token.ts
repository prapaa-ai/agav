import { secureURL } from "./secure-url.js";
import { EnterpriseAuthError, type IdentityProof } from "./types.js";

/**
 * Flow 3 — short-lived OIDC token exchange, the CI / no-human flow.
 *
 * In automation there is no browser and no person to approve a device code. The
 * CI platform itself mints a short-lived OIDC token for the workload's identity
 * (e.g. GitHub Actions OIDC); Agav reads that token and hands it to the control
 * plane like any other identity proof. No static secret is stored anywhere.
 *
 * Two sources, in order:
 *   1. a pre-supplied token in `AGAV_OIDC_TOKEN`
 *   2. a CI token-request endpoint (GitHub Actions style:
 *      ACTIONS_ID_TOKEN_REQUEST_URL + ACTIONS_ID_TOKEN_REQUEST_TOKEN)
 */

export interface OidcTokenOptions {
  /** Audience to request for the OIDC token (the control plane's audience). */
  audience?: string;
  /** Injectable env accessor for testing (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** GitHub Actions-style OIDC token request response. */
interface IdTokenResponse {
  value?: string;
}

/**
 * Fetch an OIDC token from a CI token-request endpoint (GitHub Actions style).
 * Returns undefined when the CI endpoint env vars are absent.
 */
async function fetchCiToken(
  env: NodeJS.ProcessEnv,
  audience: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const requestUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const requestToken = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!requestUrl || !requestToken) return undefined;

  const url = secureURL(requestUrl);
  if (audience) url.searchParams.set("audience", audience);

  let response: Response;
  try {
    response = await fetch(url.href, {
      method: "GET",
      headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new EnterpriseAuthError(`CI OIDC token request failed: ${(error as Error).message}`, { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new EnterpriseAuthError(`CI OIDC token request failed (HTTP ${response.status}).`);
  }
  const data = (await response.json().catch(() => ({}))) as IdTokenResponse;
  if (!data.value) throw new EnterpriseAuthError("CI OIDC token response did not include a token.");
  return data.value;
}

/**
 * Obtain an OIDC identity proof for automation. Prefers a pre-supplied
 * AGAV_OIDC_TOKEN, else requests one from the CI token endpoint. Throws when no
 * source is available so callers can fall back or fail clearly.
 */
export async function obtainIdTokenViaOidc(options: OidcTokenOptions = {}): Promise<IdentityProof> {
  const env = options.env ?? process.env;

  const direct = env["AGAV_OIDC_TOKEN"];
  if (direct) {
    return { idToken: direct, flow: "oidc-token" };
  }

  const ciToken = await fetchCiToken(env, options.audience, options.signal);
  if (ciToken) {
    return { idToken: ciToken, flow: "oidc-token" };
  }

  throw new EnterpriseAuthError(
    "No OIDC token available. Set AGAV_OIDC_TOKEN, or run in a CI environment that provides an OIDC token endpoint.",
  );
}

/** Whether an OIDC token source is present without performing a request. */
export function hasOidcTokenSource(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env["AGAV_OIDC_TOKEN"] ||
    (env["ACTIONS_ID_TOKEN_REQUEST_URL"] && env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]),
  );
}

export { fetchCiToken };
