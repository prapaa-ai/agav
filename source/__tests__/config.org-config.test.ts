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
  loadOrgConfig,
  isAtLeastAsStrict,
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
});

describe("org-config: isAtLeastAsStrict", () => {
  it("orders deny-writes as strictest and auto-accept as loosest", () => {
    expect(isAtLeastAsStrict("deny-writes", "ask")).toBe(true);
    expect(isAtLeastAsStrict("ask", "ask")).toBe(true);
    expect(isAtLeastAsStrict("auto-accept", "ask")).toBe(false);
    expect(isAtLeastAsStrict("ask", "deny-writes")).toBe(false);
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

  it("never throws on malformed JSON and falls through to undefined", async () => {
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") return "{ not valid json";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(await loadOrgConfig()).toBeUndefined();
  });

  it("ignores a non-object JSON policy", async () => {
    process.env[ORG_CONFIG_ENV] = "/custom/org.json";
    readFile.mockImplementation(async (path: unknown) => {
      if (path === "/custom/org.json") return JSON.stringify(["not", "an", "object"]);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(await loadOrgConfig()).toBeUndefined();
  });
});
