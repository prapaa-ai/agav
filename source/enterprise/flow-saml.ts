import { openExternal } from "../utils/open-external.js";
import { randomToken } from "./pkce.js";
import { startLoopbackServer } from "./loopback-server.js";
import { secureURL } from "./secure-url.js";
import { EnterpriseAuthError, type IdentityProof } from "./types.js";

/**
 * Flow 4 — SAML, brokered by the control plane (for IdPs that aren't OIDC).
 *
 * Some organizations' identity providers only speak SAML 2.0, not OIDC, so the
 * CLI cannot run OIDC discovery / PKCE against them directly. Instead the control
 * plane acts as a **SAML Service Provider**: it runs the full SAML dance with the
 * customer's IdP server-side and converts the asserted identity into the same
 * OIDC-shaped identity proof (`id_token`) the rest of Agav already understands.
 *
 * From the CLI's point of view this is a browser round-trip against the control
 * plane, not the IdP:
 *
 *   1. Start a single-use loopback server for the browser redirect.
 *   2. Open the browser to the control plane's SAML-initiation endpoint, passing
 *      the loopback `redirect_uri` and a one-time `state`.
 *   3. The control plane redirects the browser to the SAML IdP, receives the
 *      SAML assertion, and sends the browser back to the loopback `redirect_uri`
 *      with a short-lived, single-use **broker code** (plus the echoed `state`).
 *   4. Exchange that broker code at the control plane for an `id_token`.
 *
 * The CLI never parses SAML; all XML/assertion handling stays server-side. The
 * resulting proof flows into the normal `enroll` step unchanged.
 */

export interface SamlFlowOptions {
  /** Base URL of the control plane that brokers SAML (the SP). */
  controlPlane: string;
  /** Overall timeout for the interactive login. Default 300s. */
  timeoutSeconds?: number;
  /** Injectable browser opener (defaults to the platform opener); eases testing. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Injectable status reporter (defaults to stderr). */
  report?: (message: string) => void;
  /** External cancellation (e.g. Ctrl-C from the CLI). */
  signal?: AbortSignal;
}

interface SamlExchangeResponse {
  id_token?: string;
}

/** Build an endpoint URL under the control-plane base, validated and normalized. */
function controlPlaneEndpoint(controlPlane: string, path: string): URL {
  const base = secureURL(controlPlane);
  return new URL(path, base.href.endsWith("/") ? base.href : `${base.href}/`);
}

/**
 * Build the SAML-initiation URL the browser is sent to. The control plane uses
 * `redirect_uri` to send the browser back to our loopback server, and echoes
 * `state` so we can bind the returned broker code to this attempt.
 */
function initiationUrl(controlPlane: string, redirectUri: string, state: string): string {
  const url = controlPlaneEndpoint(controlPlane, "saml/initiate");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.href;
}

/**
 * Exchange a broker code for an id_token at the control plane. The control plane
 * verifies the code is single-use and unexpired, and that it was issued for a
 * completed SAML assertion, before returning the proof.
 */
async function exchangeBrokerCode(
  controlPlane: string,
  code: string,
  signal?: AbortSignal,
): Promise<SamlExchangeResponse> {
  const endpoint = controlPlaneEndpoint(controlPlane, "saml/exchange");

  let response: Response;
  try {
    response = await fetch(endpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code }),
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
    throw new EnterpriseAuthError("Control plane rejected the SAML sign-in (not authorized or no seat).");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new EnterpriseAuthError(`SAML broker exchange failed (HTTP ${response.status}).`);
  }

  let data: SamlExchangeResponse;
  try {
    data = (await response.json()) as SamlExchangeResponse;
  } catch (error) {
    throw new EnterpriseAuthError("Control plane returned a non-JSON SAML exchange response.", { cause: error });
  }
  if (!data.id_token) {
    throw new EnterpriseAuthError("SAML broker exchange did not return an id_token.");
  }
  return data;
}

/** Run the control-plane-brokered SAML flow and return an identity proof. */
export async function obtainIdTokenViaSaml(options: SamlFlowOptions): Promise<IdentityProof> {
  const report = options.report ?? ((m: string) => process.stderr.write(`${m}\n`));
  const openBrowser = options.openBrowser ?? openExternal;
  const timeoutMs = (options.timeoutSeconds ?? 300) * 1000;

  // Combine the internal timeout with the caller's cancellation so either one
  // tears down the loopback wait and the broker exchange.
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
    const state = randomToken();
    const server = await startLoopbackServer(state, controller.signal);
    try {
      const url = initiationUrl(options.controlPlane, server.redirectUri, state);

      report("Opening your browser to sign in with SAML…");
      if (!(await openBrowser(url))) {
        throw new EnterpriseAuthError(
          "Could not open a browser for SAML sign-in. SAML requires a browser on this machine.",
        );
      }

      const { code } = await server.waitForCode;
      const tokens = await exchangeBrokerCode(options.controlPlane, code, controller.signal);
      return { idToken: tokens.id_token!, flow: "saml" };
    } finally {
      server.close();
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export { initiationUrl, exchangeBrokerCode };
