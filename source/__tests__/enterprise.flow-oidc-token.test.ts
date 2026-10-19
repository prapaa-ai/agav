import { afterEach, describe, expect, it, vi } from "vitest";
import {
  obtainIdTokenViaOidc,
  hasOidcTokenSource,
} from "../enterprise/flow-oidc-token.js";
import { EnterpriseAuthError } from "../enterprise/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasOidcTokenSource", () => {
  it("is true with a direct token", () => {
    expect(hasOidcTokenSource({ AGAV_OIDC_TOKEN: "t" })).toBe(true);
  });
  it("is true with a CI token endpoint pair", () => {
    expect(hasOidcTokenSource({
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://ci/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req",
    })).toBe(true);
  });
  it("is false with neither", () => {
    expect(hasOidcTokenSource({})).toBe(false);
    // A partial CI pair does not count.
    expect(hasOidcTokenSource({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://ci/token" })).toBe(false);
  });
});

describe("obtainIdTokenViaOidc", () => {
  it("uses a pre-supplied AGAV_OIDC_TOKEN without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const proof = await obtainIdTokenViaOidc({ env: { AGAV_OIDC_TOKEN: "direct-token" } });
    expect(proof.idToken).toBe("direct-token");
    expect(proof.flow).toBe("oidc-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a token from the CI endpoint with the audience and bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ value: "ci-token" }));
    vi.stubGlobal("fetch", fetchMock);
    const proof = await obtainIdTokenViaOidc({
      audience: "agav",
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://ci/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
      },
    });
    expect(proof.idToken).toBe("ci-token");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://ci/token?audience=agav");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer req-token");
  });

  it("prefers the direct token over the CI endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const proof = await obtainIdTokenViaOidc({
      env: {
        AGAV_OIDC_TOKEN: "direct",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://ci/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req",
      },
    });
    expect(proof.idToken).toBe("direct");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a clear error when no source is available", async () => {
    await expect(obtainIdTokenViaOidc({ env: {} })).rejects.toThrow(/No OIDC token available/);
  });

  it("throws on a non-ok CI token response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 403)));
    await expect(obtainIdTokenViaOidc({
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: "https://ci/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req" },
    })).rejects.toThrow(/HTTP 403/);
  });

  it("throws when the CI response has no token value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    await expect(obtainIdTokenViaOidc({
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: "https://ci/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req" },
    })).rejects.toThrow(/did not include a token/);
  });

  it("rejects a non-HTTPS CI token endpoint", async () => {
    await expect(obtainIdTokenViaOidc({
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: "http://ci/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req" },
    })).rejects.toThrow(/HTTPS/);
  });
});
