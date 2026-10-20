import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  exchangeCode,
  obtainIdTokenViaAuthCode,
} from "../enterprise/flow-auth-code.js";
import { EnterpriseAuthError } from "../enterprise/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const discoveryDoc = {
  issuer: "https://idp.corp",
  authorization_endpoint: "https://idp.corp/authorize",
  token_endpoint: "https://idp.corp/token",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorizeUrl", () => {
  it("includes PKCE S256, state, nonce, and the redirect URI", () => {
    const href = authorizeUrl("https://idp.corp/authorize", {
      clientId: "agav-cli",
      redirectUri: "http://127.0.0.1:5000/callback",
      scope: "openid email",
      state: "st",
      nonce: "no",
      challenge: "chal",
    });
    const url = new URL(href);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("agav-cli");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5000/callback");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("nonce")).toBe("no");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("rejects a non-HTTPS authorization endpoint", () => {
    expect(() => authorizeUrl("http://idp.corp/authorize", {
      clientId: "x", redirectUri: "http://127.0.0.1/callback", scope: "openid", state: "s", nonce: "n", challenge: "c",
    })).toThrow(/HTTPS/);
  });
});

describe("exchangeCode", () => {
  it("posts the code and verifier and returns the token response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id_token: "idt", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
    const tokens = await exchangeCode("https://idp.corp/token", {
      clientId: "agav-cli", code: "abc", verifier: "ver", redirectUri: "http://127.0.0.1/callback",
    });
    expect(tokens.id_token).toBe("idt");
    const [, init] = fetchMock.mock.calls[0]!;
    const sent = new URLSearchParams(init.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("abc");
    expect(sent.get("code_verifier")).toBe("ver");
    expect(sent.get("client_id")).toBe("agav-cli");
  });

  it("throws when the token response lacks an id_token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ access_token: "a" })));
    await expect(exchangeCode("https://idp.corp/token", {
      clientId: "x", code: "c", verifier: "v", redirectUri: "http://127.0.0.1/callback",
    })).rejects.toThrow(/id_token/);
  });

  it("throws on a non-ok token response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 400)));
    await expect(exchangeCode("https://idp.corp/token", {
      clientId: "x", code: "c", verifier: "v", redirectUri: "http://127.0.0.1/callback",
    })).rejects.toThrow(/HTTP 400/);
  });
});

describe("obtainIdTokenViaAuthCode (end to end)", () => {
  it("drives discovery, browser, loopback callback, and token exchange", async () => {
    const realFetch = globalThis.fetch;
    // fetch handles discovery (GET) and token exchange (POST); loopback requests
    // to 127.0.0.1 pass through to the real fetch so the callback is delivered.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("127.0.0.1")) return realFetch(url, init);
      if (u.includes("/.well-known/openid-configuration")) return jsonResponse(discoveryDoc);
      if (u === "https://idp.corp/token" && init?.method === "POST") {
        return jsonResponse({ id_token: "the-id-token", expires_in: 3600 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // The "browser" immediately hits the loopback redirect with a valid code,
    // echoing the state it was given in the authorize URL.
    const openBrowser = vi.fn(async (authUrl: string) => {
      const u = new URL(authUrl);
      const redirect = new URL(u.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "auth-code-xyz");
      redirect.searchParams.set("state", u.searchParams.get("state")!);
      await fetch(redirect.href);
      return true;
    });

    const proof = await obtainIdTokenViaAuthCode({
      issuer: "https://idp.corp",
      clientId: "agav-cli",
      openBrowser,
      report: () => {},
    });

    expect(proof.idToken).toBe("the-id-token");
    expect(proof.flow).toBe("auth-code");
    expect(proof.nonce).toBeTruthy();
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly when the browser cannot be opened", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("openid-configuration")) return jsonResponse(discoveryDoc);
      throw new Error("no token exchange expected");
    }));
    await expect(obtainIdTokenViaAuthCode({
      issuer: "https://idp.corp",
      clientId: "agav-cli",
      openBrowser: async () => false,
      report: () => {},
    })).rejects.toThrow(/device login/);
  });

  it("errors when the IdP lacks authorization code support", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ issuer: "https://idp.corp" })));
    await expect(obtainIdTokenViaAuthCode({
      issuer: "https://idp.corp",
      clientId: "agav-cli",
      openBrowser: async () => true,
      report: () => {},
    })).rejects.toThrow(EnterpriseAuthError);
  });

  it("cancels the pending callback wait when the external signal aborts", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("127.0.0.1")) return realFetch(url, init);
      if (u.includes("/.well-known/openid-configuration")) return jsonResponse(discoveryDoc);
      throw new Error(`unexpected fetch ${url}`);
    }));

    const controller = new AbortController();
    // The browser "opens" but never delivers a callback; Ctrl-C (external abort)
    // must tear down the loopback wait instead of hanging until the timeout.
    const openBrowser = vi.fn(async () => {
      setTimeout(() => controller.abort(new EnterpriseAuthError("Login cancelled.")), 10);
      return true;
    });

    await expect(obtainIdTokenViaAuthCode({
      issuer: "https://idp.corp",
      clientId: "agav-cli",
      openBrowser,
      report: () => {},
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/i);
  });
});
