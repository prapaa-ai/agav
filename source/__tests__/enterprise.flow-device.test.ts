import { afterEach, describe, expect, it, vi } from "vitest";
import { obtainIdTokenViaDevice } from "../enterprise/flow-device.js";
import { EnterpriseAuthError } from "../enterprise/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const discoveryDoc = {
  issuer: "https://idp.corp",
  device_authorization_endpoint: "https://idp.corp/device",
  token_endpoint: "https://idp.corp/token",
};

const deviceDoc = {
  device_code: "dev-code",
  user_code: "WDJB-MJHT",
  verification_uri: "https://idp.corp/activate",
  interval: 5,
  expires_in: 300,
};

const noSleep = async () => {};

/** Build a fetch mock: fixed discovery + device responses, scripted token polls. */
function makeFetch(tokenSequence: unknown[]) {
  let pollIndex = 0;
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/.well-known/openid-configuration")) return jsonResponse(discoveryDoc);
    if (u === "https://idp.corp/device") return jsonResponse(deviceDoc);
    if (u === "https://idp.corp/token") {
      const next = tokenSequence[Math.min(pollIndex, tokenSequence.length - 1)];
      pollIndex++;
      // pending/slow_down come back as HTTP 400 with a structured error.
      const status = (next as { error?: string }).error ? 400 : 200;
      return jsonResponse(next, status);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("obtainIdTokenViaDevice", () => {
  it("prompts the user and returns an id_token once approved", async () => {
    vi.stubGlobal("fetch", makeFetch([
      { error: "authorization_pending" },
      { id_token: "the-id-token", expires_in: 3600 },
    ]));
    const prompt = vi.fn();
    const proof = await obtainIdTokenViaDevice({
      issuer: "https://idp.corp",
      clientId: "agav-cli",
      prompt,
      sleep: noSleep,
    });
    expect(proof.idToken).toBe("the-id-token");
    expect(proof.flow).toBe("device");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toMatchObject({
      userCode: "WDJB-MJHT",
      verificationUri: "https://idp.corp/activate",
    });
  });

  it("backs off on slow_down and eventually succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    vi.stubGlobal("fetch", makeFetch([
      { error: "slow_down" },
      { error: "authorization_pending" },
      { id_token: "idt" },
    ]));
    const proof = await obtainIdTokenViaDevice({
      issuer: "https://idp.corp",
      clientId: "agav-cli",
      prompt: () => {},
      sleep,
    });
    expect(proof.idToken).toBe("idt");
    // First sleep is the base interval (5s); after slow_down it grows by 5s.
    expect(sleep.mock.calls[0]![0]).toBe(5000);
    expect(sleep.mock.calls[1]![0]).toBe(10000);
  });

  it("throws when the user denies the request", async () => {
    vi.stubGlobal("fetch", makeFetch([{ error: "access_denied" }]));
    await expect(obtainIdTokenViaDevice({
      issuer: "https://idp.corp", clientId: "agav-cli", prompt: () => {}, sleep: noSleep,
    })).rejects.toThrow(/denied/);
  });

  it("throws when the device code expires", async () => {
    vi.stubGlobal("fetch", makeFetch([{ error: "expired_token" }]));
    await expect(obtainIdTokenViaDevice({
      issuer: "https://idp.corp", clientId: "agav-cli", prompt: () => {}, sleep: noSleep,
    })).rejects.toThrow(/expired/);
  });

  it("errors when the IdP does not support the device grant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ issuer: "https://idp.corp" })));
    await expect(obtainIdTokenViaDevice({
      issuer: "https://idp.corp", clientId: "agav-cli", prompt: () => {}, sleep: noSleep,
    })).rejects.toThrow(EnterpriseAuthError);
  });

  it("respects an abort signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", makeFetch([{ error: "authorization_pending" }]));
    const sleep = vi.fn(async () => { controller.abort(new Error("cancelled")); });
    await expect(obtainIdTokenViaDevice({
      issuer: "https://idp.corp", clientId: "agav-cli", prompt: () => {}, sleep, signal: controller.signal,
    })).rejects.toThrow(/cancelled/);
  });

  it("stops polling once the overall deadline elapses", async () => {
    // The IdP keeps returning pending; a tiny overall timeout must terminate the
    // loop rather than polling forever. The injected sleep advances no real time,
    // so we drive the deadline by making each poll observe elapsed wall-clock.
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      vi.stubGlobal("fetch", makeFetch([{ error: "authorization_pending" }]));
      const sleep = vi.fn(async () => { now += 60_000; }); // 60s per poll cycle
      await expect(obtainIdTokenViaDevice({
        issuer: "https://idp.corp",
        clientId: "agav-cli",
        prompt: () => {},
        sleep,
        timeoutSeconds: 120, // deadline reached after two sleeps
      })).rejects.toThrow(/timed out/);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("aborts an in-progress sleep when the device code expires before it ends", async () => {
    // expires_in (short) is well below the polling interval (long). The default
    // abortable sleep must be cut short at expiry instead of sleeping the full
    // interval, and the failure must be the code-expiry error.
    const shortExpiryDoc = { ...deviceDoc, expires_in: 0.05, interval: 10 };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/.well-known/openid-configuration")) return jsonResponse(discoveryDoc);
      if (u === "https://idp.corp/device") return jsonResponse(shortExpiryDoc);
      if (u === "https://idp.corp/token") return jsonResponse({ error: "authorization_pending" }, 400);
      throw new Error(`unexpected fetch ${url}`);
    }));
    const start = Date.now();
    await expect(obtainIdTokenViaDevice({
      issuer: "https://idp.corp",
      clientId: "agav-cli",
      prompt: () => {},
      // No injected sleep: use the real abortable delay so expiry cuts it short.
      timeoutSeconds: 300,
    })).rejects.toThrow(/expired/);
    // Rejected near expiry (~50ms), not after the 10s interval.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("enforces the overall deadline against a stalled network request", async () => {
    // Discovery never resolves on its own; only the deadline signal aborts it.
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }));
    await expect(obtainIdTokenViaDevice({
      issuer: "https://idp.corp",
      clientId: "agav-cli",
      prompt: () => {},
      timeoutSeconds: 0.05, // 50ms overall deadline
    })).rejects.toThrow();
  });
});
