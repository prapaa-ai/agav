import { describe, expect, it } from "vitest";
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
});
