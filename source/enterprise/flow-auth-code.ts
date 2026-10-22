import { openExternal } from "../utils/open-external.js";
import { createPkce, randomToken } from "./pkce.js";
import { discoverOidc } from "./oidc-discovery.js";
import { startLoopbackServer } from "./loopback-server.js";
import { secureURL } from "./secure-url.js";
import { EnterpriseAuthError, type IdentityProof } from "./types.js";

/**
 * Flow 1 — Authorization Code + PKCE (the laptop flow).
 *
 * Discovers the issuer's endpoints, generates PKCE + state + nonce, starts a
 * loopback server for the redirect, opens the browser to the authorize URL,
 * waits for the code, and exchanges code+verifier for tokens. Returns the
 * resulting id_token as an IdentityProof for the control-plane `enroll` step.
 *
 * This flow only runs where a browser can be opened on the same machine; the
 * device grant covers SSH/headless.
 */

export interface AuthCodeOptions {
  /** The identity-provider issuer base URL (from the org's control plane). */
  issuer: string;
  /** OAuth client id registered for the Agav CLI with the IdP. */
  clientId: string;
  /** Scopes to request; "openid" is always included. */
  scopes?: string[];
  /** Overall timeout for the interactive login. Default 300s. */
  timeoutSeconds?: number;
  /** Injectable browser opener (defaults to the platform opener); eases testing. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Injectable status reporter (defaults to stderr). */
  report?: (message: string) => void;
  /**
   * External cancellation (e.g. Ctrl-C from the CLI). Combined with the internal
   * timeout so aborting the caller tears down discovery, the loopback wait, and
   * the token exchange immediately instead of leaving the login pending.
   */
  signal?: AbortSignal;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/** Build the authorize URL with PKCE + state + nonce. */
function authorizeUrl(
  endpoint: string,
  params: { clientId: string; redirectUri: string; scope: string; state: string; nonce: string; challenge: string },
): string {
  const url = secureURL(endpoint);
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", params.clientId);
  q.set("redirect_uri", params.redirectUri);
  q.set("scope", params.scope);
  q.set("state", params.state);
  q.set("nonce", params.nonce);
  q.set("code_challenge", params.challenge);
  q.set("code_challenge_method", "S256");
  return url.href;
}

/** Exchange the authorization code for tokens at the token endpoint. */
async function exchangeCode(
  tokenEndpoint: string,
  params: { clientId: string; code: string; verifier: string; redirectUri: string },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
  });

  let response: Response;
  try {
    response = await fetch(secureURL(tokenEndpoint).href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new EnterpriseAuthError(`Token exchange request failed: ${(error as Error).message}`, { cause: error });
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new EnterpriseAuthError(`Token exchange failed (HTTP ${response.status}).`);
  }
  let data: TokenResponse;
  try {
    data = (await response.json()) as TokenResponse;
  } catch (error) {
    throw new EnterpriseAuthError("Token endpoint returned a non-JSON response.", { cause: error });
  }
  if (!data.id_token) {
    throw new EnterpriseAuthError("Token response did not include an id_token.");
  }
  return data;
}

/** Run the Authorization Code + PKCE flow and return an identity proof. */
export async function obtainIdTokenViaAuthCode(options: AuthCodeOptions): Promise<IdentityProof> {
  const report = options.report ?? ((m: string) => process.stderr.write(`${m}\n`));
  const openBrowser = options.openBrowser ?? openExternal;
  const timeoutMs = (options.timeoutSeconds ?? 300) * 1000;
  const scope = ["openid", ...(options.scopes ?? [])].filter((s, i, a) => a.indexOf(s) === i).join(" ");

  // Combine the internal timeout with the caller's cancellation so either one
  // tears down every in-flight step (discovery, callback wait, token exchange).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new EnterpriseAuthError("Login timed out.")), timeoutMs);
  const onExternalAbort = () => {
    controller.abort(
      options.signal?.reason instanceof Error ? options.signal.reason : new EnterpriseAuthError("Login cancelled."),
    );
  };
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const meta = await discoverOidc(options.issuer, controller.signal);
    if (!meta.authorizationEndpoint || !meta.tokenEndpoint) {
      throw new EnterpriseAuthError("Identity provider does not support the authorization code flow.");
    }

    const pkce = createPkce();
    const state = randomToken();
    const nonce = randomToken();

    const server = await startLoopbackServer(state, controller.signal);
    try {
      const url = authorizeUrl(meta.authorizationEndpoint, {
        clientId: options.clientId,
        redirectUri: server.redirectUri,
        scope,
        state,
        nonce,
        challenge: pkce.challenge,
      });

      report("Opening your browser to sign in…");
      if (!(await openBrowser(url))) {
        throw new EnterpriseAuthError(
          "Could not open a browser. Use device login instead: agav login --device",
        );
      }

      const { code } = await server.waitForCode;
      const tokens = await exchangeCode(
        meta.tokenEndpoint,
        { clientId: options.clientId, code, verifier: pkce.verifier, redirectUri: server.redirectUri },
        controller.signal,
      );

      return { idToken: tokens.id_token!, flow: "auth-code", nonce };
    } finally {
      server.close();
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export { authorizeUrl, exchangeCode };
