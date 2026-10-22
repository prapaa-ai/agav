import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

/**
 * A single-use loopback HTTP server that catches the OAuth redirect in the
 * Authorization Code flow. The CLI is a public client, so the redirect target is
 * http://127.0.0.1:<ephemeral-port>/callback; the identity provider sends the
 * browser here with the authorization code. The server validates the request
 * hard (path, method, single-valued and constant-time `state`), returns the code
 * once, then stops.
 *
 * Security mirrors mcp/oauth.ts: constant-time state comparison, exactly one
 * `state` parameter, correct path/method, and a close on first result.
 */

export interface LoopbackResult {
  code: string;
}

export interface LoopbackServer {
  /** The redirect URI to register with the IdP, e.g. http://127.0.0.1:PORT/callback. */
  redirectUri: string;
  /** Resolves with the authorization code, or rejects on denial/abort/timeout. */
  waitForCode: Promise<LoopbackResult>;
  /** Stop the server and reject a pending wait. Idempotent. */
  close(): void;
}

/** Constant-time string compare that is safe for differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Start the loopback server bound to 127.0.0.1 on an ephemeral port.
 *
 * @param expectedState the `state` value generated for this login attempt
 * @param signal        optional abort signal (overall login timeout/cancel)
 */
export async function startLoopbackServer(
  expectedState: string,
  signal?: AbortSignal,
): Promise<LoopbackServer> {
  let resolveCode!: (result: LoopbackResult) => void;
  let rejectCode!: (error: Error) => void;
  const waitForCode = new Promise<LoopbackResult>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Never let an unhandled rejection escape if close() races the handler.
  void waitForCode.catch(() => {});

  const server: Server = createServer((request, response) => {
    // A malformed request target (e.g. `GET //[/callback`) makes URL parsing
    // throw ERR_INVALID_URL. Any local client can send one without knowing the
    // state secret, so handle it as a bad request instead of letting the
    // uncaught handler exception terminate the CLI mid-login.
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end("Bad request.");
      return;
    }

    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end("Not found.");
      return;
    }

    // Validate state before acting on any callback — success OR error. The state
    // secret proves the callback belongs to this login attempt; without this a
    // local client that discovers the ephemeral port could cancel sign-in with
    // a forged `error` callback (denial of service). Mirrors mcp/oauth.ts.
    const state = url.searchParams.get("state") ?? "";
    const stateCount = url.searchParams.getAll("state").length;
    if (stateCount !== 1 || !safeEqual(state, expectedState)) {
      response.writeHead(400).end("Invalid state.");
      // Do not reject: a stray/forged callback must not cancel the real wait.
      return;
    }

    // The IdP reports a denied/failed authorization via `error`, but only a
    // state-validated callback may reject the pending login.
    if (url.searchParams.has("error")) {
      response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" })
        .end("Authorization denied.");
      rejectCode(new Error(`Authorization denied: ${url.searchParams.get("error")}`));
      return;
    }

    const code = url.searchParams.get("code");
    if (!code || url.searchParams.getAll("code").length !== 1) {
      response.writeHead(400).end("Missing authorization code.");
      return;
    }

    response
      .writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" })
      .end("Signed in. You can close this window and return to your terminal.");
    resolveCode({ code });
  });

  const close = () => {
    server.closeAllConnections?.();
    server.close();
  };

  const abortReason = () =>
    signal?.reason instanceof Error ? signal.reason : new Error("Login aborted.");

  // Reject immediately for an already-aborted signal: never start a listener.
  if (signal?.aborted) {
    rejectCode(abortReason());
    throw abortReason();
  }

  // Bind the listener. Abort during binding must settle *this* promise too, not
  // just waitForCode, so the caller's `await startLoopbackServer(...)` completes
  // (rejects) rather than hanging until the never-arriving listen callback.
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      close();
      const reason = abortReason();
      rejectCode(reason);
      reject(reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    server.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      // Listening: hand abort over to the steady-state handler below and resolve.
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    close();
    throw new Error("Could not bind the loopback redirect server.");
  }

  // Now that we are listening, an abort tears down the server and rejects the
  // pending code wait.
  if (signal) {
    if (signal.aborted) {
      close();
      rejectCode(abortReason());
    } else {
      signal.addEventListener("abort", () => {
        close();
        rejectCode(abortReason());
      }, { once: true });
    }
  }

  // Stop the server once the code is delivered so the port is released promptly.
  void waitForCode.then(close, () => {});

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode,
    close,
  };
}
