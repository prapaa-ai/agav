import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverOidc, discoveryUrl } from "../enterprise/oidc-discovery.js";
import { EnterpriseAuthError } from "../enterprise/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fullDoc = {
  issuer: "https://idp.corp",
  authorization_endpoint: "https://idp.corp/authorize",
  token_endpoint: "https://idp.corp/token",
  device_authorization_endpoint: "https://idp.corp/device",
  jwks_uri: "https://idp.corp/jwks",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoveryUrl", () => {
  it("builds the well-known path from the issuer", () => {
    expect(discoveryUrl("https://idp.corp").href).toBe("https://idp.corp/.well-known/openid-configuration");
    expect(discoveryUrl("https://idp.corp/").href).toBe("https://idp.corp/.well-known/openid-configuration");
  });

  it("rejects a non-HTTPS issuer", () => {
    expect(() => discoveryUrl("http://idp.corp")).toThrow(/HTTPS/);
  });
});

describe("discoverOidc", () => {
  it("returns the mapped endpoints on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(fullDoc)));
    const meta = await discoverOidc("https://idp.corp");
    expect(meta.issuer).toBe("https://idp.corp");
    expect(meta.authorizationEndpoint).toBe("https://idp.corp/authorize");
    expect(meta.tokenEndpoint).toBe("https://idp.corp/token");
    expect(meta.deviceAuthorizationEndpoint).toBe("https://idp.corp/device");
    expect(meta.jwksUri).toBe("https://idp.corp/jwks");
  });

  it("tolerates a missing optional endpoint", async () => {
    const { device_authorization_endpoint: _omit, ...partial } = fullDoc;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(partial)));
    const meta = await discoverOidc("https://idp.corp");
    expect(meta.deviceAuthorizationEndpoint).toBeUndefined();
    expect(meta.authorizationEndpoint).toBe("https://idp.corp/authorize");
  });

  it("rejects an issuer mismatch between request and document", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...fullDoc, issuer: "https://evil.corp" })));
    await expect(discoverOidc("https://idp.corp")).rejects.toThrow(/issuer does not match/);
  });

  it("rejects an insecure endpoint in the document", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ ...fullDoc, token_endpoint: "http://idp.corp/token" }),
    ));
    await expect(discoverOidc("https://idp.corp")).rejects.toThrow(/HTTPS/);
  });

  it("throws on a non-ok discovery response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    await expect(discoverOidc("https://idp.corp")).rejects.toThrow(/HTTP 404/);
  });

  it("throws on a non-JSON document", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 200 })));
    await expect(discoverOidc("https://idp.corp")).rejects.toThrow(/non-JSON/);
  });

  it("wraps a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(discoverOidc("https://idp.corp")).rejects.toThrow(EnterpriseAuthError);
  });

  it("propagates an abort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "AbortError" })));
    await expect(discoverOidc("https://idp.corp")).rejects.toThrow(/x/);
  });
});
