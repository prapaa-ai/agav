import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/enterprise-policy-store.js", () => ({
  saveEnrolledPolicy: vi.fn().mockResolvedValue(undefined),
}));

import { enroll, enrollmentEndpoint, persistSession, fetchAuthConfig } from "../enterprise/control-plane.js";
import { EnterpriseAuthError, type IdentityProof, type EnrollmentSession } from "../enterprise/types.js";
import { saveEnrolledPolicy } from "../config/enterprise-policy-store.js";

const proof: IdentityProof = { idToken: "header.payload.sig", flow: "auth-code", nonce: "n1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enrollmentEndpoint", () => {
  it("appends the session path to the control-plane base URL", () => {
    expect(enrollmentEndpoint("https://auth.corp").href).toBe("https://auth.corp/session");
    expect(enrollmentEndpoint("https://auth.corp/").href).toBe("https://auth.corp/session");
    expect(enrollmentEndpoint("https://auth.corp/base/").href).toBe("https://auth.corp/base/session");
  });

  it("rejects a non-HTTPS control plane", () => {
    expect(() => enrollmentEndpoint("http://auth.corp")).toThrow(/HTTPS/);
  });

  it("allows http on loopback (self-hosted dev)", () => {
    expect(enrollmentEndpoint("http://localhost:8787").href).toBe("http://localhost:8787/session");
  });
});

describe("enroll", () => {
  it("posts the identity proof and returns the parsed session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        policy: { provider: "openai", openaiBaseURL: "https://gw/v1" },
        gatewayToken: "gw-token",
        expiresAt: 1800000000000,
        subject: "jane@corp.com",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await enroll("https://auth.corp", proof);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://auth.corp/session");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({ idToken: proof.idToken, flow: "auth-code", nonce: "n1" });

    expect(session.policy.provider).toBe("openai");
    expect(session.gatewayToken).toBe("gw-token");
    expect(session.subject).toBe("jane@corp.com");
    expect(session.controlPlane).toBe("https://auth.corp");
  });

  it("throws a clear error when the control plane rejects the sign-in (401/403)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 403)));
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(EnterpriseAuthError);
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/not authorized|no seat/);
  });

  it("throws on a generic non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the response has no policy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ gatewayToken: "x" })));
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/missing a policy/);
  });

  it("rejects a malformed policy so it cannot poison the enrollment cache", async () => {
    // A non-array allowedTools would otherwise be cast and crash every later
    // startup inside applyOrgConfig. Rejecting here leaves any prior cache intact
    // (persistSession runs only on a successful enroll).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ policy: { allowedTools: { length: 1 } } })),
    );
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/malformed policy/);
  });

  it("rejects a policy whose restriction list has non-string members", async () => {
    // Fail-closed: a bad member must not be filtered into a weaker restriction;
    // the whole response is rejected, preserving any prior valid cache.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ policy: { provider: "openai", allowedModels: [1, "ok"] } })),
    );
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/malformed policy/);
  });

  it("rejects a policy that pins an unknown provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ policy: { provider: "not-a-provider" } })),
    );
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/malformed policy/);
  });

  it("returns a valid policy with well-formed restrictions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ policy: { provider: "openai", allowedModels: ["gpt-5.4"] } })),
    );
    const session = await enroll("https://auth.corp", proof);
    expect(session.policy.provider).toBe("openai");
    expect(session.policy.allowedModels).toEqual(["gpt-5.4"]);
  });

  it("throws when the response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/non-JSON/);
  });

  it("wraps a transport failure with the control-plane origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/Could not reach the control plane/);
  });

  it("propagates an abort without wrapping it", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    await expect(enroll("https://auth.corp", proof)).rejects.toThrow(/aborted/);
  });
});

describe("persistSession", () => {
  it("maps the session to an EnrolledPolicy and saves it", async () => {
    const session: EnrollmentSession = {
      policy: { provider: "openai", permissionMode: "ask" },
      gatewayToken: "gw",
      expiresAt: 1800000000000,
      subject: "jane@corp.com",
      controlPlane: "https://auth.corp",
    };
    await persistSession(session);
    expect(saveEnrolledPolicy).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveEnrolledPolicy).mock.calls[0]![0];
    expect(saved.policy).toEqual(session.policy);
    expect(saved.gatewayToken).toBe("gw");
    expect(saved.controlPlane).toBe("https://auth.corp");
    expect(saved.subject).toBe("jane@corp.com");
    expect(saved.expiresAt).toBe(1800000000000);
    expect(typeof saved.storedAt).toBe("string");
  });
});

describe("fetchAuthConfig", () => {
  it("returns IdP coordinates from the control plane", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ issuer: "https://idp.corp", clientId: "agav-cli", scopes: ["email"] }),
    ));
    const cfg = await fetchAuthConfig("https://auth.corp");
    expect(cfg).toEqual({ issuer: "https://idp.corp", clientId: "agav-cli", scopes: ["email"] });
  });

  it("requests the /auth-config endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issuer: "https://idp.corp", clientId: "x" }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAuthConfig("https://auth.corp");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://auth.corp/auth-config");
  });

  it("returns undefined on 404 (control plane does not advertise coordinates)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    expect(await fetchAuthConfig("https://auth.corp")).toBeUndefined();
  });

  it("throws when issuer or clientId is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ issuer: "https://idp.corp" })));
    await expect(fetchAuthConfig("https://auth.corp")).rejects.toThrow(/missing issuer or clientId/);
  });

  it("rejects an insecure issuer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ issuer: "http://idp.corp", clientId: "x" }),
    ));
    await expect(fetchAuthConfig("https://auth.corp")).rejects.toThrow(/HTTPS/);
  });

  it("throws on a non-ok, non-404 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    await expect(fetchAuthConfig("https://auth.corp")).rejects.toThrow(/HTTP 500/);
  });
});
