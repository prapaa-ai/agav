import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));
vi.mock("../config/org-config.js", () => ({
  loadOrgPolicy: vi.fn().mockResolvedValue({}),
}));
vi.mock("../enterprise/control-plane.js", () => ({
  enroll: vi.fn(),
  persistSession: vi.fn().mockResolvedValue(undefined),
  fetchAuthConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config/enterprise-policy-store.js", () => ({
  clearEnrolledPolicy: vi.fn().mockResolvedValue(undefined),
  loadEnrolledPolicy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../enterprise/flow-oidc-token.js", () => ({
  hasOidcTokenSource: vi.fn().mockReturnValue(false),
  obtainIdTokenViaOidc: vi.fn(),
}));
vi.mock("../enterprise/flow-auth-code.js", () => ({
  obtainIdTokenViaAuthCode: vi.fn(),
}));
vi.mock("../enterprise/flow-device.js", () => ({
  obtainIdTokenViaDevice: vi.fn(),
}));
vi.mock("../enterprise/flow-saml.js", () => ({
  obtainIdTokenViaSaml: vi.fn(),
}));
vi.mock("../enterprise/audit.js", async () => ({
  // Keep the real classifier (it is pure and part of what we assert on) but stub
  // the network-emitting recorder.
  ...(await vi.importActual<typeof import("../enterprise/audit.js")>("../enterprise/audit.js")),
  recordAuditEvent: vi.fn().mockResolvedValue(false),
}));
vi.mock("../utils/open-external.js", () => ({
  openExternal: vi.fn().mockResolvedValue(true),
}));

const { loadConfig } = await import("../config/config.js");
const { loadOrgPolicy } = await import("../config/org-config.js");
const { enroll, persistSession, fetchAuthConfig } = await import("../enterprise/control-plane.js");
const { clearEnrolledPolicy, loadEnrolledPolicy } = await import("../config/enterprise-policy-store.js");
const { hasOidcTokenSource, obtainIdTokenViaOidc } = await import("../enterprise/flow-oidc-token.js");
const { obtainIdTokenViaAuthCode } = await import("../enterprise/flow-auth-code.js");
const { obtainIdTokenViaSaml } = await import("../enterprise/flow-saml.js");
const { recordAuditEvent } = await import("../enterprise/audit.js");
const { runLoginCommand, parseLoginArgs, autoSelectFlow } = await import("../cli/login-cli.js");

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedEnroll = vi.mocked(enroll);

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadConfig.mockResolvedValue({ controlPlane: "https://auth.corp" } as any);
  // Re-establish defaults cleared by clearAllMocks.
  vi.mocked(loadOrgPolicy).mockResolvedValue({} as any);
  vi.mocked(loadEnrolledPolicy).mockResolvedValue(undefined as any);
  vi.mocked(clearEnrolledPolicy).mockResolvedValue(undefined);
  vi.mocked(persistSession).mockResolvedValue(undefined);
  vi.mocked(fetchAuthConfig).mockResolvedValue(undefined);
  vi.mocked(recordAuditEvent).mockResolvedValue(false);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("parseLoginArgs", () => {
  it("parses explicit flow and endpoint flags", () => {
    const parsed = parseLoginArgs(["--device", "--issuer", "https://idp", "--client-id=cli", "--control-plane", "https://cp"]);
    expect(parsed).toEqual({ flow: "device", issuer: "https://idp", clientId: "cli", controlPlane: "https://cp" });
  });

  it("parses the --saml flow flag", () => {
    expect(parseLoginArgs(["--saml"])).toEqual({ flow: "saml" });
  });

  it("flags unknown arguments", () => {
    expect(parseLoginArgs(["--nope"])).toEqual({ error: "unknown argument: --nope" });
  });
});

describe("autoSelectFlow", () => {
  it("uses oidc-token when a CI token source is present", () => {
    vi.mocked(hasOidcTokenSource).mockReturnValue(true);
    expect(autoSelectFlow()).toBe("oidc-token");
  });
});

describe("runLoginCommand: logout", () => {
  it("clears the cached policy", async () => {
    const code = await runLoginCommand("logout", []);
    expect(code).toBe(0);
    expect(clearEnrolledPolicy).toHaveBeenCalledTimes(1);
  });

  it("reports failure when the cache cannot be removed", async () => {
    vi.mocked(clearEnrolledPolicy).mockRejectedValueOnce(new Error("EROFS: read-only file system"));
    const code = await runLoginCommand("logout", []);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("still active"));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Signed out"));
  });
});

describe("runLoginCommand: login", () => {
  it("falls back to the hosted default control plane when nothing is configured", async () => {
    mockedLoadConfig.mockResolvedValue({} as any); // no org controlPlane
    delete process.env.AGAV_CONTROL_PLANE;
    delete process.env.AGAV_DEFAULT_CONTROL_PLANE;
    vi.mocked(obtainIdTokenViaOidc).mockResolvedValue({ idToken: "idt", flow: "oidc-token" });
    mockedEnroll.mockResolvedValue({ policy: { provider: "openai" }, controlPlane: "https://auth.agav.dev" } as any);

    const code = await runLoginCommand("login", ["--oidc"]);
    expect(code).toBe(0);
    // Login proceeds against the built-in SaaS default, not an error.
    expect(mockedEnroll).toHaveBeenCalledWith("https://auth.agav.dev", expect.anything(), expect.anything());
  });

  it("prefers an org-configured control plane over the hosted default", async () => {
    mockedLoadConfig.mockResolvedValue({ controlPlane: "https://auth.corp" } as any);
    vi.mocked(obtainIdTokenViaOidc).mockResolvedValue({ idToken: "idt", flow: "oidc-token" });
    mockedEnroll.mockResolvedValue({ policy: { provider: "openai" }, controlPlane: "https://auth.corp" } as any);

    const code = await runLoginCommand("login", ["--oidc"]);
    expect(code).toBe(0);
    expect(mockedEnroll).toHaveBeenCalledWith("https://auth.corp", expect.anything(), expect.anything());
  });

  it("runs the oidc flow, enrolls, and persists the session", async () => {
    vi.mocked(obtainIdTokenViaOidc).mockResolvedValue({ idToken: "idt", flow: "oidc-token" });
    mockedEnroll.mockResolvedValue({
      policy: { provider: "openai" },
      subject: "ci@corp",
      controlPlane: "https://auth.corp",
    } as any);

    const code = await runLoginCommand("login", ["--oidc"]);
    expect(code).toBe(0);
    expect(obtainIdTokenViaOidc).toHaveBeenCalledWith({ audience: "https://auth.corp", signal: expect.anything() });
    expect(mockedEnroll).toHaveBeenCalledWith("https://auth.corp", { idToken: "idt", flow: "oidc-token" }, expect.anything());
    expect(persistSession).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ci@corp"));
  });

  it("errors only when neither flags nor the control plane provide IdP coordinates", async () => {
    vi.mocked(fetchAuthConfig).mockResolvedValue(undefined); // control plane publishes nothing
    const code = await runLoginCommand("login", ["--auth-code"]);
    expect(code).toBe(1);
    const msg = errSpy.mock.calls[0]![0] as string;
    expect(msg).toContain("isn't fully set up"); // developer-facing
    expect(obtainIdTokenViaAuthCode).not.toHaveBeenCalled();
  });

  it("fetches IdP coordinates from the control plane for the SaaS path", async () => {
    vi.mocked(fetchAuthConfig).mockResolvedValue({ issuer: "https://idp.saas", clientId: "saas-cli", scopes: ["email"] });
    vi.mocked(obtainIdTokenViaAuthCode).mockResolvedValue({ idToken: "idt", flow: "auth-code", nonce: "n" });
    mockedEnroll.mockResolvedValue({ policy: { provider: "openai" }, controlPlane: "https://auth.corp" } as any);
    const code = await runLoginCommand("login", ["--auth-code"]); // no --issuer/--client-id
    expect(code).toBe(0);
    expect(fetchAuthConfig).toHaveBeenCalled();
    expect(obtainIdTokenViaAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: "https://idp.saas", clientId: "saas-cli", scopes: ["email"] }),
    );
  });

  it("runs the auth-code flow with explicit issuer and client-id (no control-plane fetch)", async () => {
    vi.mocked(obtainIdTokenViaAuthCode).mockResolvedValue({ idToken: "idt", flow: "auth-code", nonce: "n" });
    mockedEnroll.mockResolvedValue({ policy: { provider: "openai" }, controlPlane: "https://auth.corp" } as any);
    const code = await runLoginCommand("login", ["--auth-code", "--issuer", "https://idp", "--client-id", "cli"]);
    expect(code).toBe(0);
    expect(fetchAuthConfig).not.toHaveBeenCalled(); // flags present ⇒ no fetch
    expect(obtainIdTokenViaAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: "https://idp", clientId: "cli" }),
    );
  });

  it("returns 1 and reports when a flow throws", async () => {
    vi.mocked(obtainIdTokenViaOidc).mockRejectedValue(new Error("no token"));
    const code = await runLoginCommand("login", ["--oidc"]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith("no token");
  });

  it("runs the SAML flow brokered by the control plane (no IdP coordinates)", async () => {
    vi.mocked(obtainIdTokenViaSaml).mockResolvedValue({ idToken: "idt", flow: "saml" });
    mockedEnroll.mockResolvedValue({
      policy: { provider: "openai" },
      subject: "saml@corp",
      controlPlane: "https://auth.corp",
    } as any);

    const code = await runLoginCommand("login", ["--saml"]);
    expect(code).toBe(0);
    expect(fetchAuthConfig).not.toHaveBeenCalled(); // SAML needs no IdP coordinates
    expect(obtainIdTokenViaSaml).toHaveBeenCalledWith(
      expect.objectContaining({ controlPlane: "https://auth.corp" }),
    );
    expect(mockedEnroll).toHaveBeenCalledWith("https://auth.corp", { idToken: "idt", flow: "saml" }, expect.anything());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("saml@corp"));
  });
});

describe("runLoginCommand: audit → SIEM", () => {
  it("emits login.attempt and login.success with the control-plane origin", async () => {
    mockedLoadConfig.mockResolvedValue({ controlPlane: "https://auth.corp", auditSink: "https://siem.corp/ingest" } as any);
    vi.mocked(obtainIdTokenViaOidc).mockResolvedValue({ idToken: "idt", flow: "oidc-token" });
    mockedEnroll.mockResolvedValue({ policy: { provider: "openai" }, subject: "ci@corp", controlPlane: "https://auth.corp" } as any);

    const code = await runLoginCommand("login", ["--oidc"]);
    expect(code).toBe(0);
    const calls = vi.mocked(recordAuditEvent).mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual(
      expect.objectContaining({ action: "login.attempt", flow: "oidc-token", controlPlane: "https://auth.corp" }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({ action: "login.success", flow: "oidc-token", subject: "ci@corp" }),
    );
    // The attempt event's sink comes from the pre-enrollment config.
    const attempt = vi.mocked(recordAuditEvent).mock.calls.find((c) => c[0].action === "login.attempt")!;
    expect(attempt[1]).toEqual({ sink: "https://siem.corp/ingest" });
  });

  it("uses a sink that first arrives in the enrolled policy for login.success (P2)", async () => {
    // First enrollment: no sink configured beforehand, but the authenticated
    // session introduces auditSink. The success event must use the NEW sink,
    // re-resolved after persist, not the (empty) pre-enrollment config.
    mockedLoadConfig.mockResolvedValue({ controlPlane: "https://auth.corp" } as any); // no auditSink yet
    vi.mocked(obtainIdTokenViaOidc).mockResolvedValue({ idToken: "idt", flow: "oidc-token" });
    mockedEnroll.mockResolvedValue({ policy: { provider: "openai" }, subject: "ci@corp", controlPlane: "https://auth.corp" } as any);
    // After persistSession, the effective org policy now carries the sink.
    vi.mocked(loadOrgPolicy).mockResolvedValue({ config: { auditSink: "https://siem.enrolled/ingest" } } as any);

    const code = await runLoginCommand("login", ["--oidc"]);
    expect(code).toBe(0);
    const success = vi.mocked(recordAuditEvent).mock.calls.find((c) => c[0].action === "login.success")!;
    expect(success[1]).toEqual({ sink: "https://siem.enrolled/ingest" });
    // The attempt (pre-enrollment) had no sink, confirming the success sink was
    // re-resolved afterward.
    const attempt = vi.mocked(recordAuditEvent).mock.calls.find((c) => c[0].action === "login.attempt")!;
    expect(attempt[1]).toEqual({ sink: undefined });
  });

  it("never sends the success event to a REPLACED enrollment's sink when switching orgs (P2)", async () => {
    // Enrolled in org A (whose policy supplied auditSink); now signing into org B
    // via --control-plane, and B's policy omits auditSink. The success event must
    // NOT fall back to A's sink — otherwise B's identity leaks to A's SIEM.
    mockedLoadConfig.mockResolvedValue({ controlPlane: "https://auth.a", auditSink: "https://siem.a/ingest" } as any);
    vi.mocked(obtainIdTokenViaOidc).mockResolvedValue({ idToken: "idt", flow: "oidc-token" });
    mockedEnroll.mockResolvedValue({ policy: { provider: "openai" }, subject: "user@b", controlPlane: "https://auth.b" } as any);
    // Post-enrollment effective policy (org B) has no sink.
    vi.mocked(loadOrgPolicy).mockResolvedValue({ config: {} } as any);

    const code = await runLoginCommand("login", ["--oidc", "--control-plane", "https://auth.b"]);
    expect(code).toBe(0);
    const success = vi.mocked(recordAuditEvent).mock.calls.find((c) => c[0].action === "login.success")!;
    // No sink (env fallback applies downstream) — definitely NOT org A's sink.
    expect(success[1]).toEqual({ sink: undefined });
  });

  it("emits login.failure with an allowlisted reason code, never the raw message", async () => {
    mockedLoadConfig.mockResolvedValue({ controlPlane: "https://auth.corp", auditSink: "https://siem.corp/ingest" } as any);
    // A leaky parse-style error whose message echoes server content (a secret).
    vi.mocked(obtainIdTokenViaOidc).mockRejectedValue(
      new Error(`Unexpected token 'd', "device-secret-123" is not valid JSON`),
    );

    const code = await runLoginCommand("login", ["--oidc"]);
    expect(code).toBe(1);
    const failure = vi.mocked(recordAuditEvent).mock.calls.find((c) => c[0].action === "login.failure")!;
    // Mapped to a fixed code; the raw (secret-bearing) message is NOT forwarded.
    expect(failure[0]).toMatchObject({ action: "login.failure", flow: "oidc-token", reason: "error" });
    expect(JSON.stringify(failure[0])).not.toContain("device-secret-123");
    // The full message still reaches stderr for local debugging.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("device-secret-123"));
  });

  it("uses the enrolled record's actual origin and the effective sink for logout", async () => {
    // Self-hosted login via --control-plane whose returned policy ships auditSink
    // but omits controlPlane. The origin must come from the enrolled record's
    // metadata, NOT config.controlPlane / the hosted default.
    mockedLoadConfig.mockResolvedValue({} as any); // policy omits controlPlane
    vi.mocked(loadOrgPolicy).mockResolvedValue({ config: { auditSink: "https://siem.self/ingest" } } as any);
    vi.mocked(loadEnrolledPolicy).mockResolvedValue({
      policy: { auditSink: "https://siem.self/ingest" },
      controlPlane: "https://auth.self-hosted.corp",
      storedAt: "now",
    } as any);

    const code = await runLoginCommand("logout", []);
    expect(code).toBe(0);
    const logoutCall = vi.mocked(recordAuditEvent).mock.calls.find((c) => c[0].action === "logout")!;
    expect(logoutCall[0]).toMatchObject({ action: "logout", controlPlane: "https://auth.self-hosted.corp" });
    expect(logoutCall[1]).toEqual({ sink: "https://siem.self/ingest" });
  });

  it("reads audit config BEFORE clearing the enrollment cache, then emits after", async () => {
    // Capture-before-delete: the policy store (which holds an enrollment-sourced
    // auditSink/origin) must be read before clearEnrolledPolicy, and the logout
    // event emitted after it — so a self-hosted sink survives sign-out.
    const order: string[] = [];
    vi.mocked(loadOrgPolicy).mockImplementation(async () => {
      order.push("readPolicy");
      return { config: { auditSink: "https://siem.corp/ingest" } } as any;
    });
    vi.mocked(loadEnrolledPolicy).mockResolvedValue({
      policy: {}, controlPlane: "https://auth.corp", storedAt: "now",
    } as any);
    vi.mocked(clearEnrolledPolicy).mockImplementation(async () => { order.push("clear"); });
    vi.mocked(recordAuditEvent).mockImplementation(async (ev: any) => {
      if (ev.action === "logout") order.push("audit");
      return false;
    });

    const code = await runLoginCommand("logout", []);
    expect(code).toBe(0);
    // Policy read happens before clear; audit emitted after clear.
    expect(order.indexOf("readPolicy")).toBeLessThan(order.indexOf("clear"));
    expect(order.indexOf("clear")).toBeLessThan(order.indexOf("audit"));
  });

  it("does not emit a logout event when the cache cannot be cleared", async () => {
    vi.mocked(loadOrgPolicy).mockResolvedValue({ config: { auditSink: "https://siem.corp/ingest" } } as any);
    vi.mocked(clearEnrolledPolicy).mockRejectedValueOnce(new Error("EROFS"));
    const code = await runLoginCommand("logout", []);
    expect(code).toBe(1);
    const logoutCalls = vi.mocked(recordAuditEvent).mock.calls.filter((c) => c[0].action === "logout");
    expect(logoutCalls).toHaveLength(0);
  });
});
