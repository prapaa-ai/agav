import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initiationUrl,
  exchangeBrokerCode,
  obtainIdTokenViaSaml,
} from "../enterprise/flow-saml.js";
import { EnterpriseAuthError } from "../enterprise/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initiationUrl", () => {
  it("targets the control plane's saml/initiate endpoint with redirect_uri and state", () => {
    const href = initiationUrl("https://auth.corp", "http://127.0.0.1:5000/callback", "st");
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe("https://auth.corp/saml/initiate");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5000/callback");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("preserves a base path on the control plane", () => {
    const href = initiationUrl("https://auth.corp/base/", "http://127.0.0.1/callback", "s");
    expect(new URL(href).pathname).toBe("/base/saml/initiate");
  });

  it("rejects a non-HTTPS control plane", () => {
    expect(() => initiationUrl("http://auth.corp", "http://127.0.0.1/callback", "s")).toThrow(/HTTPS/);
  });

  it("allows http on loopback (self-hosted dev)", () => {
    const href = initiationUrl("http://localhost:8787", "http://127.0.0.1/callback", "s");
    expect(new URL(href).origin).toBe("http://localhost:8787");
  });
});

describe("exchangeBrokerCode", () => {
  it("posts the broker code and returns the id_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id_token: "idt" }));
    vi.stubGlobal("fetch", fetchMock);
    const tokens = await exchangeBrokerCode("https://auth.corp", "broker-code");
    expect(tokens.id_token).toBe("idt");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://auth.corp/saml/exchange");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ code: "broker-code" });
  });

  it("throws a clear error when the control plane rejects the sign-in (403)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 403)));
    await expect(exchangeBrokerCode("https://auth.corp", "c")).rejects.toThrow(/not authorized|no seat/);
  });

  it("throws on a generic non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    await expect(exchangeBrokerCode("https://auth.corp", "c")).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the exchange response lacks an id_token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    await expect(exchangeBrokerCode("https://auth.corp", "c")).rejects.toThrow(/id_token/);
  });

  it("throws when the response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 200 })));
    await expect(exchangeBrokerCode("https://auth.corp", "c")).rejects.toThrow(/non-JSON/);
  });

  it("wraps a transport failure with the control-plane origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(exchangeBrokerCode("https://auth.corp", "c")).rejects.toThrow(/Could not reach the control plane/);
  });

  it("propagates an abort without wrapping it", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    await expect(exchangeBrokerCode("https://auth.corp", "c")).rejects.toThrow(/aborted/);
  });
});

describe("obtainIdTokenViaSaml (end to end)", () => {
  it("drives the browser round-trip, loopback callback, and broker exchange", async () => {
    const realFetch = globalThis.fetch;
    // fetch handles the broker exchange (POST); loopback requests to 127.0.0.1
    // pass through to the real fetch so the callback is delivered.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("127.0.0.1")) return realFetch(url, init);
      if (u === "https://auth.corp/saml/exchange" && init?.method === "POST") {
        return jsonResponse({ id_token: "the-id-token" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // The "browser" immediately hits the loopback redirect with a broker code,
    // echoing the state it was given in the initiation URL.
    const openBrowser = vi.fn(async (initUrl: string) => {
      const u = new URL(initUrl);
      const redirect = new URL(u.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "broker-code-xyz");
      redirect.searchParams.set("state", u.searchParams.get("state")!);
      await fetch(redirect.href);
      return true;
    });

    const proof = await obtainIdTokenViaSaml({
      controlPlane: "https://auth.corp",
      openBrowser,
      report: () => {},
    });

    expect(proof.idToken).toBe("the-id-token");
    expect(proof.flow).toBe("saml");
    expect(openBrowser).toHaveBeenCalledTimes(1);
    // The browser was sent to the control plane's initiation endpoint.
    expect(new URL(openBrowser.mock.calls[0]![0]).pathname).toBe("/saml/initiate");
  });

  it("fails cleanly when the browser cannot be opened", async () => {
    await expect(obtainIdTokenViaSaml({
      controlPlane: "https://auth.corp",
      openBrowser: async () => false,
      report: () => {},
    })).rejects.toThrow(/browser/i);
  });

  it("cancels the pending callback wait when the external signal aborts", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("127.0.0.1")) return realFetch(url, init);
      throw new Error(`unexpected fetch ${url}`);
    }));

    const controller = new AbortController();
    const openBrowser = vi.fn(async () => {
      setTimeout(() => controller.abort(new EnterpriseAuthError("Login cancelled.")), 10);
      return true;
    });

    await expect(obtainIdTokenViaSaml({
      controlPlane: "https://auth.corp",
      openBrowser,
      report: () => {},
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/i);
  });
});
