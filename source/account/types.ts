/**
 * Consumer Agav account types.
 *
 * Distinct from the enterprise tier: a consumer account is an *opt-in* paid
 * identity a person creates on the Agav website (OAuth) and connects to the CLI
 * with an Agav-issued API key. It never carries an org policy and never
 * restricts the user — signing in only ADDS capabilities (today: identity;
 * later: model access through Agav's gateway). Free local (BYO-key) use and
 * enterprise enrollment are unaffected.
 */

/** Error thrown for any consumer-account sign-in/validation failure. */
export class AccountError extends Error {}

/**
 * The account identity returned by the account service's whoami endpoint for a
 * valid, non-revoked Agav API key. Mirrors `GET /api/account/whoami`:
 *   200 { accountId, email, status }
 * `status` is "active" today; subscription/entitlement states are layered later.
 */
export interface AccountIdentity {
  accountId: string;
  email: string | null;
  status: string;
}

/**
 * The cached consumer account record stored locally after a successful sign-in.
 * The API key is the credential; the identity fields are informational (shown in
 * /status). Stored encrypted at rest, mirroring the enterprise policy store.
 */
export interface StoredAccount {
  /** The Agav API key (agav_sk_...). Encrypted at rest. */
  apiKey: string;
  /** Account id the key resolved to at sign-in. */
  accountId: string;
  /** Email at sign-in (informational). */
  email: string | null;
  /** Subscription/entitlement status at sign-in (informational snapshot). */
  status: string;
  /** Account-service origin this key was validated against, for later refresh. */
  accountService: string;
  /** When this record was written (ISO-8601). */
  storedAt: string;
}
