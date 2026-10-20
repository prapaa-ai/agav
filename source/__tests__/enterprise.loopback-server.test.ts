import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import { startLoopbackServer } from "../enterprise/loopback-server.js";

/** Extract the ephemeral base URL (origin) from the redirect URI. */
function originOf(redirectUri: string): string {
  return new URL(redirectUri).origin;
}

describe("loopback-server", () => {
  it("returns a 127.0.0.1 /callback redirect URI on an ephemeral port", async () => {
    const server = await startLoopbackServer("state-123");
    try {
      const url = new URL(server.redirectUri);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toBe("/callback");
      expect(Number(url.port)).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("resolves with the code when state matches", async () => {
    const server = await startLoopbackServer("state-123");
    const res = await fetch(`${server.redirectUri}?code=the-code&state=state-123`);
    expect(res.status).toBe(200);
    const result = await server.waitForCode;
    expect(result.code).toBe("the-code");
  });

  it("rejects a callback whose state does not match (and keeps waiting)", async () => {
    const server = await startLoopbackServer("state-123");
    try {
      const res = await fetch(`${server.redirectUri}?code=x&state=wrong`);
      expect(res.status).toBe(400);
      // The real wait must NOT have resolved/rejected from the forged callback.
      const settled = await Promise.race([
        server.waitForCode.then(() => "resolved", () => "rejected"),
        new Promise((r) => setTimeout(() => r("pending"), 50)),
      ]);
      expect(settled).toBe("pending");
    } finally {
      server.close();
    }
  });

  it("rejects when the IdP reports an error", async () => {
    const server = await startLoopbackServer("state-123");
    const res = await fetch(`${server.redirectUri}?error=access_denied&state=state-123`);
    expect(res.status).toBe(400);
    await expect(server.waitForCode).rejects.toThrow(/denied/);
  });

  it("returns 404 for a non-/callback path", async () => {
    const server = await startLoopbackServer("state-123");
    try {
      const res = await fetch(`${originOf(server.redirectUri)}/other`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("400s a callback missing the code", async () => {
    const server = await startLoopbackServer("state-123");
    try {
      const res = await fetch(`${server.redirectUri}?state=state-123`);
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("400s a callback with duplicated state parameters", async () => {
    const server = await startLoopbackServer("state-123");
    try {
      const res = await fetch(`${server.redirectUri}?code=x&state=state-123&state=state-123`);
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("rejects the wait when aborted", async () => {
    const controller = new AbortController();
    const server = await startLoopbackServer("state-123", controller.signal);
    controller.abort(new Error("timed out"));
    await expect(server.waitForCode).rejects.toThrow(/timed out/);
  });

  it("rejects startup immediately for an already-aborted signal (no listener started)", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    // The startup promise must reject, not resolve with a live listener.
    await expect(startLoopbackServer("state-123", controller.signal)).rejects.toThrow(/pre-aborted/);
  });

  it("settles the startup promise when aborted during binding", async () => {
    const controller = new AbortController();
    const startup = startLoopbackServer("state-123", controller.signal);
    // Abort on the next tick — overlapping the listen() binding window.
    queueMicrotask(() => controller.abort(new Error("aborted-during-bind")));
    // Must settle (reject) rather than hang forever.
    const settled = await Promise.race([
      startup.then(() => "resolved", (e) => (e instanceof Error ? e.message : "rejected")),
      new Promise<string>((r) => setTimeout(() => r("pending"), 500)),
    ]);
    expect(settled === "pending").toBe(false);
    // If it bound before the abort, tidy up the live server.
    await startup.then((s) => s.close(), () => {});
  });

  it("does not reject on an error callback with a missing/forged state", async () => {
    // A local client that lacks the state secret must not be able to cancel the
    // pending login with a forged `error` callback (denial of service).
    const server = await startLoopbackServer("state-123");
    try {
      const missing = await fetch(`${server.redirectUri}?error=access_denied`);
      expect(missing.status).toBe(400);
      const forged = await fetch(`${server.redirectUri}?error=access_denied&state=wrong`);
      expect(forged.status).toBe(400);
      const settled = await Promise.race([
        server.waitForCode.then(() => "resolved", () => "rejected"),
        new Promise((r) => setTimeout(() => r("pending"), 50)),
      ]);
      expect(settled).toBe("pending");
    } finally {
      server.close();
    }
  });

  it("400s a malformed request target and keeps serving a later legitimate callback", async () => {
    const server = await startLoopbackServer("state-123");
    const port = Number(new URL(server.redirectUri).port);
    try {
      // Send a raw, malformed request line that URL parsing cannot handle.
      // It must not crash the handler; the server must respond and keep listening.
      const status = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write("GET //[/callback HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        });
        let data = "";
        socket.on("data", (chunk) => { data += chunk.toString(); });
        socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
        socket.on("error", reject);
        setTimeout(() => reject(new Error("no response to malformed request")), 2000);
      });
      expect(status).toContain("400");

      // A legitimate callback on the same still-running server must succeed.
      const res = await fetch(`${server.redirectUri}?code=the-code&state=state-123`);
      expect(res.status).toBe(200);
      const result = await server.waitForCode;
      expect(result.code).toBe("the-code");
    } finally {
      server.close();
    }
  });
});
