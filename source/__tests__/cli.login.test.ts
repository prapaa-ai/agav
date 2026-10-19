import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));
vi.mock("../enterprise/control-plane.js", () => ({
  enroll: vi.fn(),
  persistSession: vi.fn().mockResolvedValue(undefined),
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
const { enroll, persistSession } = await import("../enterprise/control-plane.js");
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
});

describe("runLoginCommand: login", () => {
  it("errors when no control plane is configured", async () => {
    mockedLoadConfig.mockResolvedValue({} as any);
    const code = await runLoginCommand("login", []);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("No control plane"));
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
    expect(obtainIdTokenViaOidc).toHaveBeenCalledWith({ audience: "https://auth.corp" });
    expect(mockedEnroll).toHaveBeenCalledWith("https://auth.corp", { idToken: "idt", flow: "oidc-token" }, expect.anything());
    expect(persistSession).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ci@corp"));
  });

  it("requires issuer and client-id for interactive flows", async () => {
    const code = await runLoginCommand("login", ["--auth-code"]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--issuer"));
    expect(obtainIdTokenViaAuthCode).not.toHaveBeenCalled();
  });

  it("runs the auth-code flow when issuer and client-id are provided", async () => {
    vi.mocked(obtainIdTokenViaAuthCode).mockResolvedValue({ idToken: "idt", flow: "auth-code", nonce: "n" });
    mockedEnroll.mockResolvedValue({ policy: { provider: "openai" }, controlPlane: "https://auth.corp" } as any);
    const code = await runLoginCommand("login", ["--auth-code", "--issuer", "https://idp", "--client-id", "cli"]);
    expect(code).toBe(0);
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
