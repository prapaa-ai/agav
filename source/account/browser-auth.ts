import { resolveAccountService } from "./account-address.js";
import { startAuthorization, pollToken, acknowledge, type AuthorizationRequest } from "./browser-auth-client.js";
import { whoami } from "./account-client.js";
import { saveStoredAccount, SaveCancelledError } from "./account-store.js";
import { AccountError, type AccountIdentity, type StoredAccount } from "./types.js";

/**
 * Orchestrates "Sign in with your Agav account" (wizard option 1): the
 * device-authorization flow end to end. Start a request, open the browser, poll
 * until the user approves, then validate + store the delivered key and
 * acknowledge receipt. No API key is ever typed by the user.
 */

export interface BrowserSignInCallbacks {
  /** Show the user code + verification URL and whether the browser opened. */
  onPrompt: (info: { userCode: string; verificationUrl: string; openedBrowser: boolean }) => void;
  /** Open a URL in the browser; returns whether it launched. */
  openBrowser: (url: string) => Promise<boolean>;
  /** Optional sink for progress/status transitions ("waiting", "approved", …). */
  onStatus?: (status: "waiting" | "approved" | "saving") => void;
}

export interface BrowserSignInOptions extends BrowserSignInCallbacks {
  accountService?: string;
  /** Cancels the whole flow (user hit Ctrl-C / Esc). */
  signal?: AbortSignal;
  /** Injectable delay, so tests don't actually wait between polls. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AccountError("Sign-in cancelled.");
}

/**
 * Run the browser sign-in. Resolves with the signed-in identity once the key is
 * validated, stored, and acknowledged. Throws AccountError on denial, timeout,
 * cancellation, or a service failure.
 */
export async function signInWithBrowser(options: BrowserSignInOptions): Promise<AccountIdentity> {
  const accountService = resolveAccountService({ flag: options.accountService });
  const origin = new URL(accountService).href.endsWith("/")
    ? new URL(accountService).href
    : `${new URL(accountService).href}`;
  void origin;
  const sleep = options.sleep ?? defaultSleep;

  throwIfAborted(options.signal);
  const request: AuthorizationRequest = await startAuthorization(accountService, options.signal);

  // Open the browser to the pre-filled verification URL, then show the code so
  // the user can compare it (and fall back to typing it if the browser failed).
  const openedBrowser = await options.openBrowser(request.verificationUrlComplete).catch(() => false);
  options.onPrompt({
    userCode: request.userCode,
    verificationUrl: request.verificationUrl,
    openedBrowser,
  });
  options.onStatus?.("waiting");

  const key = await pollUntilApproved(accountService, request, sleep, options.signal);

  // Validate the delivered key and fetch the account identity (also our signal
  // that the key works before we commit it locally).
  options.onStatus?.("approved");
  throwIfAborted(options.signal);
  const identity = await whoami(accountService, key, options.signal);

  // Persist locally BEFORE acknowledging — ack means "durably stored".
  options.onStatus?.("saving");
  throwIfAborted(options.signal);
  const record: StoredAccount = {
    apiKey: key,
    accountId: identity.accountId,
    email: identity.email,
    status: identity.status,
    accountService: new URL(accountService).origin,
    storedAt: new Date().toISOString(),
  };
  try {
    await saveStoredAccount(record, { signal: options.signal });
  } catch (error) {
    if (error instanceof SaveCancelledError) throw new AccountError("Sign-in cancelled.");
    throw new AccountError(
      `Signed in, but could not save your account locally: ${(error as Error).message}`,
      { cause: error },
    );
  }

  // Acknowledge receipt now that the key is stored. Best-effort with a couple of
  // retries for a lost response; a failure here doesn't lose the (already saved)
  // key — the server simply revokes it at the grant deadline if never acked, but
  // we've validated it works, so we report success and let ack retry briefly.
  await acknowledgeWithRetry(accountService, request.deviceCode, key, sleep, options.signal);

  return identity;
}

/** Poll the token endpoint until approved, respecting interval/backoff/expiry/cancel. */
async function pollUntilApproved(
  accountService: string,
  request: AuthorizationRequest,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const deadline = Date.now() + request.expiresIn * 1000;
  let intervalMs = Math.max(request.interval, 1) * 1000;

  // Wait one interval before the first poll (the server also enforces this).
  await sleep(intervalMs);
  for (;;) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) {
      throw new AccountError("Sign-in timed out. Run /login again to retry.");
    }
    const result = await pollToken(accountService, request.deviceCode, signal);
    switch (result.status) {
      case "approved":
        return result.key;
      case "denied":
        throw new AccountError("Sign-in was declined in the browser.");
      case "expired":
        throw new AccountError("Sign-in expired. Run /login again to retry.");
      case "slow_down":
        // Back off: increase the interval so we stop tripping the rate limiter.
        intervalMs = Math.min(intervalMs + 2000, 15_000);
        await sleep(result.retryAfterMs ?? intervalMs);
        break;
      case "error":
        // Transient service error: wait and retry within the deadline.
        await sleep(intervalMs);
        break;
      case "pending":
      default:
        await sleep(intervalMs);
        break;
    }
  }
}

/** Acknowledge with a few bounded retries for a lost response. Never throws. */
async function acknowledgeWithRetry(
  accountService: string,
  deviceCode: string,
  key: string,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return;
    if (await acknowledge(accountService, deviceCode, key, signal)) return;
    await sleep(1000);
  }
}
