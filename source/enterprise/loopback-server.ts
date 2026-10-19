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
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end("Not found.");
      return;
    }

    // The IdP reports a denied/failed authorization via `error`.
    if (url.searchParams.has("error")) {
      response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" })
        .end("Authorization denied.");
      rejectCode(new Error(`Authorization denied: ${url.searchParams.get("error")}`));
      return;
    }

    const state = url.searchParams.get("state") ?? "";
    const stateCount = url.searchParams.getAll("state").length;
    if (stateCount !== 1 || !safeEqual(state, expectedState)) {
      response.writeHead(400).end("Invalid state.");
      // Do not reject: a stray/forged callback must not cancel the real wait.
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

  if (signal) {
    if (signal.aborted) {
      close();
      rejectCode(signal.reason instanceof Error ? signal.reason : new Error("Login aborted."));
    } else {
      signal.addEventListener("abort", () => {
        close();
        rejectCode(signal.reason instanceof Error ? signal.reason : new Error("Login aborted."));
      }, { once: true });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    close();
    throw new Error("Could not bind the loopback redirect server.");
  }

  // Stop the server once the code is delivered so the port is released promptly.
  void waitForCode.then(close, () => {});

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode,
    close,
  };
}
