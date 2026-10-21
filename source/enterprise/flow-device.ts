import { discoverOidc } from "./oidc-discovery.js";
import { secureURL } from "./secure-url.js";
import { EnterpriseAuthError, type IdentityProof } from "./types.js";

/**
 * Flow 2 — Device Authorization Grant (RFC 8628), the SSH/headless flow.
 *
 * When no browser can be opened on the machine running Agav, the user
 * authenticates on a second device: Agav shows a short user_code and a URL, the
 * human approves there, and Agav polls the token endpoint until approval. No
 * loopback server or local browser is required.
 */

export interface DeviceFlowOptions {
  issuer: string;
  clientId: string;
  scopes?: string[];
  /** Overall timeout; also bounded by the IdP's expires_in. Default 300s. */
  timeoutSeconds?: number;
  /** How the user_code / URL is shown to the human (defaults to stderr). */
  prompt?: (info: DevicePrompt) => void;
  /** Injectable clock delay, so tests don't actually wait between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
}

interface DeviceAuthorizationResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  expires_in?: number;
  error?: string;
}

/**
 * Abortable delay: resolves after `ms`, or rejects promptly if `signal` aborts
 * mid-wait so a long polling interval / `slow_down` back-off can never outlast
 * the overall deadline.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason instanceof Error ? signal!.reason : new Error("Aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Request a device/user code pair from the device authorization endpoint. */
async function requestDeviceCode(
  endpoint: string,
  clientId: string,
  scope: string,
  signal?: AbortSignal,
): Promise<DeviceAuthorizationResponse> {
  const body = new URLSearchParams({ client_id: clientId, scope });
  let response: Response;
  try {
    response = await fetch(secureURL(endpoint).href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new EnterpriseAuthError(`Device authorization request failed: ${(error as Error).message}`, { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new EnterpriseAuthError(`Device authorization failed (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as DeviceAuthorizationResponse;
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new EnterpriseAuthError("Device authorization response was incomplete.");
  }
  return data;
}

/** One poll of the token endpoint for the device grant. */
async function pollToken(
  tokenEndpoint: string,
  clientId: string,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: clientId,
  });
  const response = await fetch(secureURL(tokenEndpoint).href, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    redirect: "error",
    signal,
  });
  // RFC 8628 returns 400 with a structured `error` for pending/slow_down; parse
  // the body regardless of status so those are handled, not thrown as HTTP errors.
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  return data;
}

/** Run the device authorization grant and return an identity proof. */
export async function obtainIdTokenViaDevice(options: DeviceFlowOptions): Promise<IdentityProof> {
  const prompt = options.prompt ?? ((info: DevicePrompt) => {
    process.stderr.write(
      `\nTo sign in, visit ${info.verificationUri} and enter code: ${info.userCode}\n` +
      `Waiting for approval…\n`,
    );
  });
  const scope = ["openid", ...(options.scopes ?? [])].filter((s, i, a) => a.indexOf(s) === i).join(" ");

  // Bound the whole flow with an overall deadline, combined with the caller's
  // cancellation. This single signal is threaded through discovery, device
  // authorization, token polling, and the between-poll delays so a stalled IdP
  // fetch or a long interval can never keep the login pending past the deadline.
  const overallMsRequested = (options.timeoutSeconds ?? 300) * 1000;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new EnterpriseAuthError("Device sign-in timed out before approval.")),
    overallMsRequested,
  );
  const onCallerAbort = () => deadlineController.abort(
    options.signal?.reason instanceof Error ? options.signal.reason : new EnterpriseAuthError("Login cancelled."),
  );
  if (options.signal) {
    if (options.signal.aborted) onCallerAbort();
    else options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const signal = deadlineController.signal;
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms, signal));

  try {
    const meta = await discoverOidc(options.issuer, signal);
    if (!meta.deviceAuthorizationEndpoint || !meta.tokenEndpoint) {
      throw new EnterpriseAuthError("Identity provider does not support the device authorization grant.");
    }

    const device = await requestDeviceCode(meta.deviceAuthorizationEndpoint, options.clientId, scope, signal);
    const expiresInSeconds = device.expires_in ?? 300;
    prompt({
      userCode: device.user_code!,
      verificationUri: device.verification_uri!,
      verificationUriComplete: device.verification_uri_complete,
      expiresInSeconds,
    });

    // Stop at the earlier of the overall deadline and the IdP's device-code
    // expiry. Shorten the aborting timer to that deadline so an already-running
    // sleep or in-flight poll is aborted the instant the code expires — not only
    // checked between iterations. This prevents a long interval (e.g.
    // expires_in: 10, interval: 60) from sleeping past expiry, and prevents a
    // poll that started just before expiry from returning a token afterward.
    const expiryMs = expiresInSeconds * 1000;
    // Which constraint binds decides the error message and the abort deadline.
    const codeExpiresFirst = expiryMs < overallMsRequested;
    const deadline = Date.now() + Math.min(overallMsRequested, expiryMs);
    const msUntilDeadline = Math.max(0, deadline - Date.now());
    clearTimeout(deadlineTimer);
    const deadlineError = codeExpiresFirst
      ? new EnterpriseAuthError("The device code expired before approval.")
      : new EnterpriseAuthError("Device sign-in timed out before approval.");
    const effectiveDeadlineTimer = setTimeout(() => deadlineController.abort(deadlineError), msUntilDeadline);
    let intervalMs = Math.max(1, device.interval ?? 5) * 1000;

    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        await sleep(intervalMs);
        signal.throwIfAborted();
        // Guard against a non-aborting injected sleep (tests): stop before a
        // poll if the code already expired.
        if (Date.now() >= deadline) break;

        const result = await pollToken(meta.tokenEndpoint, options.clientId, device.device_code!, signal);

        // A poll may have completed right at expiry; never accept a token past it.
        signal.throwIfAborted();
        if (Date.now() >= deadline) break;

        if (result.id_token) {
          return { idToken: result.id_token, flow: "device" };
        }
        switch (result.error) {
          case "authorization_pending":
            break; // keep polling at the current interval
          case "slow_down":
            intervalMs += 5000; // RFC 8628: back off by 5s
            break;
          case "access_denied":
            throw new EnterpriseAuthError("Sign-in was denied.");
          case "expired_token":
            throw new EnterpriseAuthError("The device code expired before approval.");
          default:
            if (result.error) throw new EnterpriseAuthError(`Device sign-in failed: ${result.error}`);
            // No id_token and no error: treat as pending and keep polling.
        }
      }
    } finally {
      clearTimeout(effectiveDeadlineTimer);
    }

    // Loop exited because Date.now() >= deadline (e.g. a non-aborting injected
    // sleep in tests). Report whichever bound was reached.
    throw deadlineError;
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export { requestDeviceCode, pollToken };
