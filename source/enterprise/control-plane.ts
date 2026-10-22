import { secureURL } from "./secure-url.js";
import {
  EnterpriseAuthError,
  type AuthConfig,
  type EnrollmentSession,
  type IdentityProof,
} from "./types.js";
import { sanitizeOrgConfig } from "../config/org-config.js";

/**
 * Flow-agnostic client for the enterprise control plane.
 *
 * Every login flow produces an identity proof (an OIDC id_token) and calls
 * `enroll` here. The control plane verifies the proof server-side (JWKS, iss,
 * aud, exp, nonce), checks the user's seat/role, and returns the enforced policy
 * plus a short-lived gateway credential. The control plane is never on the
 * inference path — it brokers identity and policy only.
 *
 * This client does no model traffic; it only exchanges the proof for a session.
 */

/** Build an endpoint URL under the control-plane base, validated and normalized. */
function controlPlaneEndpoint(controlPlane: string, path: string): URL {
  const base = secureURL(controlPlane);
  return new URL(path, base.href.endsWith("/") ? base.href : `${base.href}/`);
}

/** Discover the control plane's enrollment endpoint from its base URL. */
function enrollmentEndpoint(controlPlane: string): URL {
  return controlPlaneEndpoint(controlPlane, "session");
}

/**
 * Fetch the IdP coordinates (issuer, client id, scopes) from the control plane
 * so interactive login works without the developer supplying them — the SaaS
 * path. Returns undefined when the control plane does not publish them (404),
 * so the caller can fall back to explicit flags or report a clear error. Other
 * failures throw.
 */
export async function fetchAuthConfig(
  controlPlane: string,
  signal?: AbortSignal,
): Promise<AuthConfig | undefined> {
  const endpoint = controlPlaneEndpoint(controlPlane, "auth-config");

  let response: Response;
  try {
    response = await fetch(endpoint.href, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new EnterpriseAuthError(
      `Could not reach the control plane at ${endpoint.origin}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  if (response.status === 404) {
    // Control plane does not advertise IdP coordinates; caller falls back.
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new EnterpriseAuthError(`Control plane auth-config request failed (HTTP ${response.status}).`);
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw new EnterpriseAuthError("Control plane returned a non-JSON auth-config response.", { cause: error });
  }
  const issuer = typeof data.issuer === "string" ? data.issuer : undefined;
  const clientId = typeof data.clientId === "string" ? data.clientId : undefined;
  if (!issuer || !clientId) {
    throw new EnterpriseAuthError("Control plane auth-config is missing issuer or clientId.");
  }
  secureURL(issuer); // reject an insecure issuer early
  const scopes = Array.isArray(data.scopes)
    ? data.scopes.filter((s): s is string => typeof s === "string")
    : undefined;
  return { issuer, clientId, scopes };
}

/**
 * Narrow and validate the control plane's response into an EnrollmentSession.
 * Throws on a response missing the policy, so a malformed server reply never
 * yields a session with no enforcement.
 */
function parseSession(data: unknown, controlPlane: string): EnrollmentSession {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new EnterpriseAuthError("Control plane returned a malformed session response.");
  }
  const obj = data as Record<string, unknown>;
  const policy = obj.policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new EnterpriseAuthError("Control plane session response is missing a policy.");
  }
  // Validate and coerce the policy's known fields before accepting it. A
  // malformed field (e.g. a non-array `allowedTools`) would otherwise be cast,
  // persisted to the cache, and crash every subsequent startup. Throwing here
  // leaves any previously-valid cached policy untouched, since persistSession
  // runs only on a successful enroll.
  const sanitizedPolicy = sanitizeOrgConfig(policy);
  if (!sanitizedPolicy) {
    throw new EnterpriseAuthError("Control plane session response contained a malformed policy.");
  }
  return {
    policy: sanitizedPolicy,
    gatewayToken: typeof obj.gatewayToken === "string" ? obj.gatewayToken : undefined,
    expiresAt: typeof obj.expiresAt === "number" ? obj.expiresAt : undefined,
    subject: typeof obj.subject === "string" ? obj.subject : undefined,
    controlPlane,
  };
}

/**
 * Exchange an identity proof for an enrollment session.
 *
 * @param controlPlane base URL of the control plane (the "starting address")
 * @param proof        the id_token + flow metadata produced by a login flow
 * @param signal       optional abort signal (login timeout / cancellation)
 */
export async function enroll(
  controlPlane: string,
  proof: IdentityProof,
  signal?: AbortSignal,
): Promise<EnrollmentSession> {
  const endpoint = enrollmentEndpoint(controlPlane);

  let response: Response;
  try {
    response = await fetch(endpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ idToken: proof.idToken, flow: proof.flow, nonce: proof.nonce }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new EnterpriseAuthError(
      `Could not reach the control plane at ${endpoint.origin}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new EnterpriseAuthError(
      "Control plane rejected the sign-in (not authorized or no seat).",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new EnterpriseAuthError(
      `Control plane enrollment failed (HTTP ${response.status}).`,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new EnterpriseAuthError("Control plane returned a non-JSON session response.", {
      cause: error,
    });
  }
  return parseSession(data, secureURL(controlPlane).origin);
}

/**
 * Persist an enrollment session as the cached org policy so subsequent startups
 * enforce it offline. Bridges the control-plane response to the policy store;
 * every login flow calls this after a successful `enroll`.
 */
export async function persistSession(session: EnrollmentSession): Promise<void> {
  const { saveEnrolledPolicy } = await import("../config/enterprise-policy-store.js");
  await saveEnrolledPolicy({
    policy: session.policy,
    gatewayToken: session.gatewayToken,
    controlPlane: session.controlPlane,
    subject: session.subject,
    expiresAt: session.expiresAt,
    storedAt: new Date().toISOString(),
  });
}

export { enrollmentEndpoint };
