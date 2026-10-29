import { afterEach, describe, expect, it, vi } from "vitest";
import { whoami, accountEndpoint } from "../account/account-client.js";
import { AccountError } from "../account/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accountEndpoint", () => {
  it("appends the whoami path to the account-service base URL", () => {
    expect(accountEndpoint("https://agav.dev", "api/account/whoami").href)
      .toBe("https://agav.dev/api/account/whoami");
    expect(accountEndpoint("https://agav.dev/", "api/account/whoami").href)
      .toBe("https://agav.dev/api/account/whoami");
  });

  it("rejects a non-HTTPS account service", () => {
    expect(() => accountEndpoint("http://agav.dev", "api/account/whoami")).toThrow(/HTTPS/);
  });

  it("allows http on loopback (staging/dev)", () => {
    expect(accountEndpoint("http://localhost:3000", "api/account/whoami").href)
      .toBe("http://localhost:3000/api/account/whoami");
  });
});

describe("whoami", () => {
  it("sends the key as a bearer token and returns the parsed identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ accountId: "acct_1", email: "a@b.com", status: "active" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const identity = await whoami("https://agav.dev", "agav_sk_secret");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://agav.dev/api/account/whoami");
    expect(init.headers.authorization).toBe("Bearer agav_sk_secret");
    expect(identity).toEqual({ accountId: "acct_1", email: "a@b.com", status: "active" });
  });

  it("treats a 401 as an invalid key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401)));
    await expect(whoami("https://agav.dev", "agav_sk_bad")).rejects.toThrow(AccountError);
    await expect(whoami("https://agav.dev", "agav_sk_bad")).rejects.toThrow(/valid Agav API key/i);
  });

  it("distinguishes a 503 (retryable) from a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unavailable" }, 503)));
    await expect(whoami("https://agav.dev", "agav_sk_x")).rejects.toThrow(/temporarily unavailable/i);
  });

  it("rejects a response missing the account id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ email: "a@b.com" })));
    await expect(whoami("https://agav.dev", "agav_sk_x")).rejects.toThrow(/missing an account id/i);
  });

  it("defaults a missing email to null and an unknown status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_2" })));
    const identity = await whoami("https://agav.dev", "agav_sk_x");
    expect(identity.email).toBeNull();
    expect(identity.status).toBe("unknown");
  });

  it("wraps a network failure in AccountError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(whoami("https://agav.dev", "agav_sk_x")).rejects.toThrow(/Could not reach/i);
  });

  it("never echoes the raw transport error message (which can contain the key)", async () => {
    // Simulate fetch's invalid-header error that embeds the Authorization value.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new Error('Headers.append: "Bearer agav_sk_leakyvalue" is an invalid header value.'),
    ));
    const err = await whoami("https://agav.dev", "agav_sk_leakyvalue").catch((e) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect((err as Error).message).not.toContain("agav_sk_leakyvalue");
  });

  it("passes an abort signal to fetch for cancellation/timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_1", status: "active" }));
    vi.stubGlobal("fetch", fetchMock);
    await whoami("https://agav.dev", "agav_sk_x");
    const init = fetchMock.mock.calls[0]![1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("propagates a caller abort as an AbortError, not a generic failure", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_u, init) => {
      // Simulate fetch honoring the already-aborted signal.
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(Object.assign(err, { aborted: init?.signal?.aborted }));
    }));
    await expect(whoami("https://agav.dev", "agav_sk_x", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
