import { afterEach, describe, expect, it, vi } from "vitest";
import { startAuthorization, pollToken, acknowledge } from "../account/browser-auth-client.js";
import { AccountError } from "../account/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SERVICE = "https://agav.dev";
const STARTED = {
  deviceCode: "dev_abc", userCode: "ABCD-2345",
  verificationUrl: "https://agav.dev/cli-auth",
  verificationUrlComplete: "https://agav.dev/cli-auth?code=ABCD-2345",
  expiresIn: 600, interval: 2,
};

afterEach(() => vi.unstubAllGlobals());

describe("startAuthorization", () => {
  it("posts to /start and returns the request on 201", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(STARTED, 201));
    vi.stubGlobal("fetch", fetchMock);
    const req = await startAuthorization(SERVICE);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://agav.dev/api/cli-auth/start");
    expect(req).toMatchObject({ deviceCode: "dev_abc", userCode: "ABCD-2345", interval: 2 });
  });

  it("rejects a verification URL that isn't same-origin as the account service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...STARTED, verificationUrl: "https://evil.example/cli-auth", verificationUrlComplete: "https://evil.example/cli-auth" }, 201)));
    await expect(startAuthorization(SERVICE)).rejects.toThrow(/mismatched|unsafe/i);
  });

  it("maps 429 to a rate-limit message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "rate_limited" }, 429)));
    await expect(startAuthorization(SERVICE)).rejects.toThrow(/too many/i);
  });

  it("rejects an incomplete response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ deviceCode: "x" }, 201)));
    await expect(startAuthorization(SERVICE)).rejects.toThrow(/incomplete/i);
  });
});

describe("pollToken", () => {
  const cases: [string, number, string, string][] = [
    ["pending", 200, "pending", "pending"],
    ["slow_down body", 200, "slow_down", "slow_down"],
    ["slow_down 429", 429, "", "slow_down"],
    ["denied", 400, "denied", "denied"],
    ["expired", 400, "expired", "expired"],
    ["error 503", 503, "error", "error"],
    ["acknowledged→expired", 200, "acknowledged", "expired"],
  ];
  it.each(cases)("maps %s", async (_label, status, bodyStatus, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(bodyStatus ? { status: bodyStatus } : {}, status)));
    const r = await pollToken(SERVICE, "dev_abc");
    expect(r.status).toBe(expected);
  });

  it("returns the key on approved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "approved", key: "agav_sk_delivered" })));
    const r = await pollToken(SERVICE, "dev_abc");
    expect(r).toEqual({ status: "approved", key: "agav_sk_delivered" });
  });

  it("treats an approved response with no key as an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "approved" })));
    expect((await pollToken(SERVICE, "dev_abc")).status).toBe("error");
  });
});

describe("acknowledge", () => {
  it("returns true only on {status:acknowledged}", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "acknowledged" })));
    expect(await acknowledge(SERVICE, "dev_abc", "agav_sk_x")).toBe(true);
  });
  it("returns false on a non-ack response and never throws on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "expired" }, 400)));
    expect(await acknowledge(SERVICE, "dev_abc", "agav_sk_x")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    expect(await acknowledge(SERVICE, "dev_abc", "agav_sk_x")).toBe(false);
  });
});
