import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../config/enterprise-policy-store.js", () => ({
  loadEnrolledPolicy: vi.fn(),
}));

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const { loadEnrolledPolicy } = await import("../config/enterprise-policy-store.js");
const mockedLoadEnrolled = vi.mocked(loadEnrolledPolicy);

const {
  applyOrgConfig,
  applyGatewayToken,
  loadOrgConfig,
  loadOrgPolicy,
  isAtLeastAsStrict,
  sanitizeOrgConfig,
  clampPermissionMode,
  managedPinError,
  ORG_CONFIG_ENV,
} = await import("../config/org-config.js");
import type { AgavConfig } from "../config/config.js";

/** Minimal resolved config to overlay org policy onto. */
function baseConfig(overrides: Partial<AgavConfig> = {}): AgavConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    effort: "high",
    permissionMode: "auto-accept",
    maxTokens: 16384,
    maxIterations: 800,
    errorRetries: 5,
    backgroundAutomation: "on",
    ...overrides,
  };
}

describe("org-config: applyOrgConfig", () => {
  it("returns config unchanged when there is no org policy", () => {
    const cfg = baseConfig();
    const result = applyOrgConfig(cfg, undefined);
    expect(result).toBe(cfg);
    expect(result.provider).toBe("anthropic");
  });

  it("hard-pins provider, model, gateway URL and headers", () => {
    const cfg = baseConfig({ provider: "anthropic", model: "user-model" });
    applyOrgConfig(cfg, {
      provider: "openai",
      model: "gpt-5.4",
      openaiBaseURL: "https://gw.corp.com/v1",
      openaiHeaders: { "x-tenant": "team-a" },
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.4");
    expect(cfg.openaiBaseURL).toBe("https://gw.corp.com/v1");
    expect(cfg.openaiHeaders).toEqual({ "x-tenant": "team-a" });
  });

  it("clamps a looser user permissionMode up to the org floor", () => {
    const cfg = baseConfig({ permissionMode: "auto-accept" });
    applyOrgConfig(cfg, { permissionMode: "ask" });
    expect(cfg.permissionMode).toBe("ask");
  });

  it("keeps a stricter user permissionMode (user may tighten, not loosen)", () => {
    const cfg = baseConfig({ permissionMode: "deny-writes" });
    applyOrgConfig(cfg, { permissionMode: "ask" });
    expect(cfg.permissionMode).toBe("deny-writes");
  });

  it("merges org required tools additively with the user allowlist", () => {
    const cfg = baseConfig({ allowedTools: ["read_file", "grep_search"] });
    applyOrgConfig(cfg, { allowedTools: ["read_file", "overview"] });
    // Org tools first, user's extras appended without duplication.
    expect(cfg.allowedTools).toEqual(["read_file", "overview", "grep_search"]);
  });

  it("surfaces allowedModels, allowedProviders, and controlPlane on the config", () => {
    const cfg = baseConfig();
    applyOrgConfig(cfg, {
      allowedModels: ["gpt-5.4", "claude-sonnet-4"],
      allowedProviders: ["openai", "anthropic"],
      controlPlane: "https://auth.corp.com",
    });
    expect(cfg.orgAllowedModels).toEqual(["gpt-5.4", "claude-sonnet-4"]);
    expect(cfg.orgAllowedProviders).toEqual(["openai", "anthropic"]);
    expect(cfg.controlPlane).toBe("https://auth.corp.com");
  });

  it("surfaces the org auditSink on the config", () => {
    const cfg = baseConfig();
    applyOrgConfig(cfg, { auditSink: "https://siem.corp/ingest" });
    expect(cfg.auditSink).toBe("https://siem.corp/ingest");
  });

  it("adopts the sole allowed provider and model when exactly one is allowed", () => {
    const cfg = baseConfig({ provider: "openai", model: "gpt-5.4" });
    applyOrgConfig(cfg, {
      allowedProviders: ["anthropic"],
      allowedModels: ["claude-sonnet-4-20250514"],
    });
    // Single-option allowlist → use it, sparing the user from --provider/--model.
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-20250514");
  });

  it("does not adopt from a multi-option allowlist (user selection enforced later)", () => {
    const cfg = baseConfig({ provider: "openai", model: "gpt-5.4" });
    applyOrgConfig(cfg, {
      allowedProviders: ["anthropic", "openai"],
      allowedModels: ["a", "b"],
    });
    expect(cfg.provider).toBe("openai"); // unchanged
    expect(cfg.model).toBe("gpt-5.4");
  });

  it("a hard-pinned provider/model takes precedence over the single-allowed convenience", () => {
    const cfg = baseConfig();
    applyOrgConfig(cfg, {
      provider: "gemini",
      allowedProviders: ["anthropic"], // pin wins over the allowlist convenience
    });
    expect(cfg.provider).toBe("gemini");
  });
});

describe("org-config: isAtLeastAsStrict", () => {
  it("orders deny-writes as strictest and auto-accept as loosest", () => {
    expect(isAtLeastAsStrict("deny-writes", "ask")).toBe(true);
    expect(isAtLeastAsStrict("ask", "ask")).toBe(true);
    expect(isAtLeastAsStrict("auto-accept", "ask")).toBe(false);
    expect(isAtLeastAsStrict("ask", "deny-writes")).toBe(false);
  });
});

describe("org-config: applyOrgConfig records managed constraints", () => {
  it("records hard pins and the permission floor so later boundaries can re-enforce", () => {
    const cfg = baseConfig({ permissionMode: "auto-accept" });
    applyOrgConfig(cfg, { provider: "openai", model: "gpt-5.4", permissionMode: "ask" });
    expect(cfg.orgManagedProvider).toBe("openai");
    expect(cfg.orgManagedModel).toBe("gpt-5.4");
    expect(cfg.orgPermissionFloor).toBe("ask");
  });

  it("leaves managed-constraint fields unset when the org pins nothing", () => {
    const cfg = baseConfig();
    applyOrgConfig(cfg, { allowedModels: ["a", "b"] });
    expect(cfg.orgManagedProvider).toBeUndefined();
    expect(cfg.orgManagedModel).toBeUndefined();
    expect(cfg.orgPermissionFloor).toBeUndefined();
  });
});

describe("org-config: managedPinError", () => {
  it("rejects a provider/model that drifted from a hard pin", () => {
    // Even without allowlists, a pin is mandatory and must be caught after
    // later startup routing / selection changes the value.
    expect(managedPinError({ ...baseConfig({ provider: "ollama" }), orgManagedProvider: "openai" }))
      .toMatch(/requires provider/);
    expect(managedPinError({ ...baseConfig({ model: "other" }), orgManagedModel: "gpt-5.4" }))
      .toMatch(/requires model/);
  });

  it("passes when the pins are satisfied or absent", () => {
    expect(managedPinError(baseConfig())).toBeNull();
    expect(managedPinError({ ...baseConfig({ provider: "openai" }), orgManagedProvider: "openai" })).toBeNull();
  });
});

describe("org-config: clampPermissionMode", () => {
  it("returns the request when no floor is set", () => {
    expect(clampPermissionMode("auto-accept", undefined)).toBe("auto-accept");
  });

  it("clamps a looser request up to the floor", () => {
    expect(clampPermissionMode("auto-accept", "ask")).toBe("ask");
    expect(clampPermissionMode("ask", "deny-writes")).toBe("deny-writes");
  });

  it("keeps a request that is already at least as strict as the floor", () => {
    expect(clampPermissionMode("deny-writes", "ask")).toBe("deny-writes");
    expect(clampPermissionMode("ask", "ask")).toBe("ask");
  });
});

describe("org-config: sanitizeOrgConfig", () => {
  it("fails closed when a restriction list is the wrong container type", () => {
    // A non-array allowedTools would make applyOrgConfig throw on every startup.
    // A security policy must not be silently weakened, so the whole policy is
    // rejected rather than dropping the malformed restriction.
    expect(sanitizeOrgConfig({ provider: "openai", allowedTools: { length: 1 } })).toBeUndefined();
    expect(sanitizeOrgConfig({ allowedModels: "gpt" })).toBeUndefined();
    expect(sanitizeOrgConfig({ permissionMode: "bogus" })).toBeUndefined();
  });

  it("fails closed when a restriction list contains a non-string member", () => {
    // A member of the wrong type could silently drop out and weaken the
    // restriction, so the whole policy is rejected instead of filtered.
    expect(sanitizeOrgConfig({ provider: "openai", allowedModels: [1, "ok", null] })).toBeUndefined();
    expect(sanitizeOrgConfig({ allowedProviders: ["openai", 7] })).toBeUndefined();
  });

  it("fails closed on an empty restriction list (empty means no restriction)", () => {
    expect(sanitizeOrgConfig({ allowedModels: [] })).toBeUndefined();
  });

  it("rejects an unknown provider pin or allowlisted provider", () => {
    expect(sanitizeOrgConfig({ provider: "not-a-provider" })).toBeUndefined();
    expect(sanitizeOrgConfig({ allowedProviders: ["openai", "nope"] })).toBeUndefined();
  });

  it("ignores a scalar field of the wrong type", () => {
    // model is a free-form string; a non-string value is simply dropped.
    const sanitized = sanitizeOrgConfig({ model: 42, openaiBaseURL: "https://gw/v1" });
    expect(sanitized!.model).toBeUndefined();
    expect(sanitized!.openaiBaseURL).toBe("https://gw/v1");
  });

  it("returns undefined for a non-object input", () => {
    expect(sanitizeOrgConfig(null)).toBeUndefined();
    expect(sanitizeOrgConfig([1, 2])).toBeUndefined();
    expect(sanitizeOrgConfig("x")).toBeUndefined();
  });

  it("keeps well-formed known fields intact", () => {
    const sanitized = sanitizeOrgConfig({
      provider: "anthropic",
      model: "claude",
      permissionMode: "deny-writes",
      allowedTools: ["read_file"],
      openaiHeaders: { "x-tenant": "a", bad: 1 },
      controlPlane: "https://auth.corp",
    });
    expect(sanitized).toEqual({
      provider: "anthropic",
      model: "claude",
      permissionMode: "deny-writes",
      allowedTools: ["read_file"],
      openaiHeaders: { "x-tenant": "a" },
      controlPlane: "https://auth.corp",
    });
  });
});

describe("org-config: loadOrgConfig", () => {
  beforeEach(() => {
    readFile.mockReset();
    mockedLoadEnrolled.mockReset().mockResolvedValue(undefined);
    delete process.env[ORG_CONFIG_ENV];
  });

  it("returns undefined when neither a file nor an enrolled policy exists", async () => {
    readFile.mockImplementation(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(await loadOrgConfig()).toBeUndefined();
  });

  it("falls back to the enrolled policy when no file source exists", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    mockedLoadEnrolled.mockResolvedValue({
      policy: { provider: "anthropic", permissionMode: "ask" },
      storedAt: "2026-01-01T00:00:00.000Z",
    });
    const org = await loadOrgConfig();
    expect(org?.provider).toBe("anthropic");
    expect(org?.permissionMode).toBe("ask");
  });

  it("prefers an admin-shipped file over an enrolled policy", async () => {
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") return JSON.stringify({ provider: "openai" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    mockedLoadEnrolled.mockResolvedValue({
      policy: { provider: "anthropic" },
      storedAt: "2026-01-01T00:00:00.000Z",
    });
    const org = await loadOrgConfig();
    expect(org?.provider).toBe("openai"); // file wins; enrolled not consulted
    expect(mockedLoadEnrolled).not.toHaveBeenCalled();
  });

  it("reads the policy from the path named by the env var", async () => {
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") {
        return JSON.stringify({ provider: "openai", openaiBaseURL: "https://gw/v1" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const org = await loadOrgConfig();
    expect(org?.provider).toBe("openai");
    expect(org?.openaiBaseURL).toBe("https://gw/v1");
  });

  it("fails closed on a present policy file with malformed JSON", async () => {
    // A present-but-malformed managed file must not silently disable enforcement:
    // only a genuinely absent file permits unmanaged startup.
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") return "{ not valid json";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await expect(loadOrgConfig()).rejects.toThrow(/not valid JSON/);
  });

  it("fails closed when a present policy file cannot be read (permission/I/O)", async () => {
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") throw Object.assign(new Error("denied"), { code: "EACCES" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await expect(loadOrgConfig()).rejects.toThrow(/could not be read/);
  });

  it("treats a genuinely missing file (ENOENT) as absent and permits unmanaged startup", async () => {
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(await loadOrgConfig()).toBeUndefined();
  });

  it("surfaces an error for a present-but-invalid policy file (non-object JSON)", async () => {
    // A readable file that parses but is structurally wrong is present-but-invalid
    // and must be reported, not silently treated as "no policy".
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") return JSON.stringify(["not", "an", "object"]);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await expect(loadOrgConfig()).rejects.toThrow(/must be a JSON object/);
  });

  it("surfaces an error for a present policy file with an invalid restriction", async () => {
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") return JSON.stringify({ provider: "openai", allowedModels: [] });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await expect(loadOrgConfig()).rejects.toThrow(/allowedModels/);
  });
});

describe("org-config: applyGatewayToken", () => {
  const gatewayPolicy = { openaiBaseURL: "https://gateway.corp/v1" };

  it("injects the token as an Authorization bearer header when the policy pins a gateway", () => {
    const config = baseConfig({ openaiBaseURL: "https://gateway.corp/v1" });
    applyGatewayToken(config, gatewayPolicy, "gw-secret");
    expect(config.openaiHeaders).toEqual({ Authorization: "Bearer gw-secret" });
    expect(config.openaiGatewayAuth).toBe(true);
  });

  it("merges the header alongside policy-pinned headers", () => {
    const config = baseConfig({ openaiBaseURL: "https://gateway.corp/v1", openaiHeaders: { "x-tenant": "team-a" } });
    applyGatewayToken(config, { ...gatewayPolicy, openaiHeaders: { "x-tenant": "team-a" } }, "gw-secret");
    expect(config.openaiHeaders).toEqual({
      "x-tenant": "team-a",
      Authorization: "Bearer gw-secret",
    });
  });

  // --- Fix #2: never send the token to an endpoint the org did not designate ---
  it("does NOT inject when the org policy pins no gateway URL", () => {
    // Policy is valid but has only permissionMode; the user has their own endpoint.
    const config = baseConfig({ openaiBaseURL: "https://api.openai.com/v1" });
    applyGatewayToken(config, { permissionMode: "ask" }, "gw-secret");
    expect(config.openaiHeaders).toBeUndefined();
    expect(config.openaiGatewayAuth).toBeUndefined();
  });

  // --- Fix #3: only a POLICY-pinned Authorization is exempt ---
  it("does not override an Authorization header pinned by the org policy", () => {
    const config = baseConfig({
      openaiBaseURL: "https://gateway.corp/v1",
      openaiHeaders: { Authorization: "Bearer admin-pinned" },
    });
    applyGatewayToken(
      config,
      { ...gatewayPolicy, openaiHeaders: { Authorization: "Bearer admin-pinned" } },
      "gw-secret",
    );
    expect(config.openaiHeaders).toEqual({ Authorization: "Bearer admin-pinned" });
  });

  it("respects a case-insensitively policy-pinned Authorization header", () => {
    const config = baseConfig({
      openaiBaseURL: "https://gateway.corp/v1",
      openaiHeaders: { authorization: "Bearer admin-pinned" },
    });
    applyGatewayToken(
      config,
      { ...gatewayPolicy, openaiHeaders: { authorization: "Bearer admin-pinned" } },
      "gw-secret",
    );
    expect(config.openaiHeaders).toEqual({ authorization: "Bearer admin-pinned" });
  });

  it("REPLACES a user-sourced Authorization header (not policy-pinned)", () => {
    // Old credential inherited from global/project config must not suppress the
    // org token, since the policy pins the gateway but no Authorization header.
    const config = baseConfig({
      openaiBaseURL: "https://gateway.corp/v1",
      openaiHeaders: { authorization: "Bearer old-user-key" },
    });
    applyGatewayToken(config, gatewayPolicy, "gw-secret");
    expect(config.openaiHeaders).toEqual({ Authorization: "Bearer gw-secret" });
    expect(config.openaiGatewayAuth).toBe(true);
  });

  it("is a no-op when there is no token", () => {
    const config = baseConfig({ openaiBaseURL: "https://gateway.corp/v1", openaiHeaders: { "x-tenant": "team-a" } });
    applyGatewayToken(config, gatewayPolicy, undefined);
    expect(config.openaiHeaders).toEqual({ "x-tenant": "team-a" });
    expect(config.openaiGatewayAuth).toBeUndefined();
  });
});

describe("org-config: loadOrgPolicy gateway token", () => {
  beforeEach(() => {
    readFile.mockReset();
    mockedLoadEnrolled.mockReset().mockResolvedValue(undefined);
    delete process.env[ORG_CONFIG_ENV];
  });

  it("returns the enrolled policy's gateway token", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    mockedLoadEnrolled.mockResolvedValue({
      policy: { provider: "openai", openaiBaseURL: "https://gw/v1" },
      gatewayToken: "gw-secret",
      storedAt: "2026-01-01T00:00:00.000Z",
    });
    const resolved = await loadOrgPolicy();
    expect(resolved.config?.openaiBaseURL).toBe("https://gw/v1");
    expect(resolved.gatewayToken).toBe("gw-secret");
  });

  it("returns no gateway token when an admin file source wins", async () => {
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") return JSON.stringify({ provider: "openai" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    // Even if an enrolled policy with a token exists, the file source outranks it
    // and a file carries no gateway credential.
    mockedLoadEnrolled.mockResolvedValue({
      policy: { provider: "anthropic" },
      gatewayToken: "gw-secret",
      storedAt: "2026-01-01T00:00:00.000Z",
    });
    const resolved = await loadOrgPolicy();
    expect(resolved.config?.provider).toBe("openai");
    expect(resolved.gatewayToken).toBeUndefined();
    expect(mockedLoadEnrolled).not.toHaveBeenCalled();
  });

  it("returns an empty result when nothing is enrolled", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const resolved = await loadOrgPolicy();
    expect(resolved.config).toBeUndefined();
    expect(resolved.gatewayToken).toBeUndefined();
  });
});
