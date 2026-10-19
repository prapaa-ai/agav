import { secureURL } from "./secure-url.js";
import { EnterpriseAuthError } from "./types.js";

/**
 * Minimal OIDC discovery: read an identity provider's published metadata so a
 * login flow learns the exact authorization/token/device endpoints instead of
 * hardcoding them. Every endpoint is validated through `secureURL` before use.
 */

export interface OidcMetadata {
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  jwksUri?: string;
}

/** Build the discovery document URL from an issuer base URL. */
export function discoveryUrl(issuer: string): URL {
  const base = secureURL(issuer);
  const prefix = base.href.endsWith("/") ? base.href : `${base.href}/`;
  return new URL(".well-known/openid-configuration", prefix);
}

/**
 * Fetch and validate the issuer's OIDC metadata. Throws EnterpriseAuthError on
 * an unreachable endpoint, a non-OK response, non-JSON, an issuer mismatch, or
 * an endpoint that fails the transport-security check.
 */
export async function discoverOidc(issuer: string, signal?: AbortSignal): Promise<OidcMetadata> {
  const url = discoveryUrl(issuer);

  let response: Response;
  try {
    response = await fetch(url.href, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new EnterpriseAuthError(
      `Could not reach the identity provider at ${url.origin}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new EnterpriseAuthError(`OIDC discovery failed (HTTP ${response.status}) at ${url.origin}.`);
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw new EnterpriseAuthError("OIDC discovery returned a non-JSON document.", { cause: error });
  }

  const docIssuer = typeof data.issuer === "string" ? data.issuer : undefined;
  if (!docIssuer) throw new EnterpriseAuthError("OIDC metadata is missing an issuer.");
  // The issuer in the document must match the one we asked about (ignoring a
  // trailing slash), per the OIDC discovery spec — defeats a swapped-issuer doc.
  if (secureURL(docIssuer).href.replace(/\/$/, "") !== secureURL(issuer).href.replace(/\/$/, "")) {
    throw new EnterpriseAuthError("OIDC metadata issuer does not match the requested issuer.");
  }

  const pick = (key: string): string | undefined => {
    const value = data[key];
    if (typeof value !== "string") return undefined;
    secureURL(value); // throws if the endpoint is not transport-safe
    return value;
  };

  return {
    issuer: docIssuer,
    authorizationEndpoint: pick("authorization_endpoint"),
    tokenEndpoint: pick("token_endpoint"),
    deviceAuthorizationEndpoint: pick("device_authorization_endpoint"),
    jwksUri: pick("jwks_uri"),
  };
}
