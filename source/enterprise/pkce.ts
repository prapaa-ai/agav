import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) helpers for the Authorization
 * Code flow. A CLI is a public client and cannot keep a client secret, so PKCE
 * binds the authorization code to a one-time verifier: an intercepted code is
 * useless without the verifier, which never leaves this process.
 */

export interface Pkce {
  /** High-entropy secret kept in memory and sent only in the token exchange. */
  verifier: string;
  /** SHA-256(verifier), base64url — sent in the authorization request. */
  challenge: string;
  /** Always "S256"; plain is intentionally not supported. */
  method: "S256";
}

/** base64url without padding, per RFC 7636. */
function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a fresh PKCE verifier/challenge pair. */
export function createPkce(): Pkce {
  // 32 random bytes -> 43-char base64url verifier, within the RFC's 43–128 range.
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Generate an opaque anti-CSRF `state` / `nonce` value. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}
