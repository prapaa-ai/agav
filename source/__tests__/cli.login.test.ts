import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));
vi.mock("../enterprise/control-plane.js", () => ({
  enroll: vi.fn(),
  persistSession: vi.fn().mockResolvedValue(undefined),
  fetchAuthConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config/enterprise-policy-store.js", () => ({
  clearEnrolledPolicy: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../enterprise/audit.js", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(false),
}));
vi.mock("../utils/open-external.js", () => ({
  openExternal: vi.fn().mockResolvedValue(true),
}));

const { loadConfig } = await import("../config/config.js");
const { enroll, persistSession, fetchAuthConfig } = await import("../enterprise/control-plane.js");
const { clearEnrolledPolicy } = await import("../config/enterprise-policy-store.js");
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
    // The sink from org policy is passed to the recorder.
    const opts = vi.mocked(recordAuditEvent).mock.calls[0]![1];
    expect(opts).toEqual({ sink: "https://siem.corp/ingest" });
  });

  it("emits login.failure with the reason when a flow throws", async () => {
    mockedLoadConfig.mockResolvedValue({ controlPlane: "https://auth.corp", auditSink: "https://siem.corp/ingest" } as any);
    vi.mocked(obtainIdTokenViaOidc).mockRejectedValue(new Error("no token"));

    const code = await runLoginCommand("login", ["--oidc"]);
    expect(code).toBe(1);
    const calls = vi.mocked(recordAuditEvent).mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual(
      expect.objectContaining({ action: "login.failure", flow: "oidc-token", reason: "no token" }),
    );
  });

  it("emits a logout audit event with the enrollment-sourced sink", async () => {
    mockedLoadConfig.mockResolvedValue({ controlPlane: "https://auth.corp", auditSink: "https://siem.corp/ingest" } as any);
    const code = await runLoginCommand("logout", []);
    expect(code).toBe(0);
    const logoutCall = vi.mocked(recordAuditEvent).mock.calls.find((c) => c[0].action === "logout")!;
    expect(logoutCall[0]).toMatchObject({ action: "logout", controlPlane: "https://auth.corp" });
    // The sink captured from config (which may be enrollment-sourced) is used.
    expect(logoutCall[1]).toEqual({ sink: "https://siem.corp/ingest" });
  });

  it("reads audit config BEFORE clearing the enrollment cache, then emits after", async () => {
    // Capture-before-delete: loadConfig (which reads the policy store that holds an
    // enrollment-sourced auditSink) must run before clearEnrolledPolicy, and the
    // logout event after it — so a self-hosted sink survives sign-out.
    const order: string[] = [];
    mockedLoadConfig.mockImplementation(async () => {
      order.push("loadConfig");
      return { controlPlane: "https://auth.corp", auditSink: "https://siem.corp/ingest" } as any;
    });
    vi.mocked(clearEnrolledPolicy).mockImplementation(async () => { order.push("clear"); });
    vi.mocked(recordAuditEvent).mockImplementation(async (ev: any) => {
      if (ev.action === "logout") order.push("audit");
      return false;
    });

    const code = await runLoginCommand("logout", []);
    expect(code).toBe(0);
    expect(order).toEqual(["loadConfig", "clear", "audit"]);
  });

  it("does not emit a logout event when the cache cannot be cleared", async () => {
    mockedLoadConfig.mockResolvedValue({ auditSink: "https://siem.corp/ingest" } as any);
    vi.mocked(clearEnrolledPolicy).mockRejectedValueOnce(new Error("EROFS"));
    const code = await runLoginCommand("logout", []);
    expect(code).toBe(1);
    const logoutCalls = vi.mocked(recordAuditEvent).mock.calls.filter((c) => c[0].action === "logout");
    expect(logoutCalls).toHaveLength(0);
  });
});
