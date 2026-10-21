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
vi.mock("../utils/open-external.js", () => ({
  openExternal: vi.fn().mockResolvedValue(true),
}));

const { loadConfig } = await import("../config/config.js");
const { enroll, persistSession, fetchAuthConfig } = await import("../enterprise/control-plane.js");
const { clearEnrolledPolicy } = await import("../config/enterprise-policy-store.js");
const { hasOidcTokenSource, obtainIdTokenViaOidc } = await import("../enterprise/flow-oidc-token.js");
const { obtainIdTokenViaAuthCode } = await import("../enterprise/flow-auth-code.js");
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
});
