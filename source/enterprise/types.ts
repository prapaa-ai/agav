import type { OrgConfig } from "../config/org-config.js";

/**
 * Shared enterprise auth/enrollment types.
 *
 * All login flows (Authorization Code + PKCE, Device Authorization Grant,
 * short-lived OIDC token exchange for CI, and control-plane-brokered SAML)
 * converge on the same shape: each flow produces an *identity proof* (an OIDC
 * id_token), hands it to the control plane, and receives a *session* (policy +
 * short-lived gateway credential). The control-plane client and session handling
 * are therefore flow-agnostic; only the "obtain the id_token" step differs per
 * flow. For SAML the control plane brokers the assertion and mints the id_token,
 * so even an IdP that isn't OIDC produces the same proof shape.
 */

/** How the identity proof was obtained. Recorded for diagnostics/audit. */
export type AuthFlow = "auth-code" | "device" | "oidc-token" | "saml";

/** An OIDC identity proof produced by a login flow and sent to the control plane. */
export interface IdentityProof {
  /** The OIDC id_token (a signed JWT) asserting who the user/workload is. */
  idToken: string;
  /** Which flow produced it. */
  flow: AuthFlow;
  /** The nonce the flow generated, echoed for the control plane to verify. */
  nonce?: string;
}

/** The control plane's response to presenting an identity proof. */
export interface EnrollmentSession {
  /** The enforced org policy, same shape the file source produces. */
  policy: OrgConfig;
  /** Short-lived credential scoped to the customer's gateway (opaque to Agav). */
  gatewayToken?: string;
  /** Unix ms when the gateway token / session expires. */
  expiresAt?: number;
  /** The subject the session was issued for. */
  subject?: string;
  /** Control-plane address that issued this session, for later refresh. */
  controlPlane: string;
}

/**
 * IdP coordinates the control plane hands the CLI so SaaS developers don't have
 * to know them. Returned by the control plane's auth-config endpoint; used to
 * run the interactive (auth-code / device) flows.
 */
export interface AuthConfig {
  /** OIDC issuer base URL. */
  issuer: string;
  /** OAuth client id registered for the Agav CLI. */
  clientId: string;
  /** Optional additional scopes beyond "openid". */
  scopes?: string[];
}

/** Error thrown for any enterprise auth/enrollment failure. */
export class EnterpriseAuthError extends Error {}
