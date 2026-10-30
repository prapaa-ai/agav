import { beforeEach, describe, expect, it, vi } from "vitest";

// Lock-file handle; captures the ownership token written during acquisition so
// the lock-path read during release can return it (and the release can unlink).
const lockState = { token: "" };
const lockHandle = {
  writeFile: vi.fn(async (data: string) => { lockState.token = data; }),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(lockHandle),
  stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() }),
}));
vi.mock("../utils/fs.js", () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/encrypt.js", () => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => (value.startsWith("enc:") ? value.slice(4) : value)),
  isEncrypted: vi.fn((value: string) => value.startsWith("enc:")),
}));
// Default to "no OS credential store" so config save/load exercises the
// in-file encryption fallback deterministically; keychain behaviour has its own
// unit tests. Individual tests can override isKeychainAvailable per case.
//
// The mock fns are hoisted so their identities stay stable across the
// vi.resetModules() done in beforeEach: both this test file and config.js must
// observe the same spies after a reset, otherwise per-test mockImplementation
// calls would land on a stale instance.
const keychainMock = vi.hoisted(() => ({
  isKeychainAvailable: vi.fn(),
  isKeychainRef: vi.fn((value: string) => value.startsWith("keychain:")),
  isStoreUnresponsive: vi.fn(() => false),
  keychainAccount: vi.fn((value: string) => (value.startsWith("keychain:") ? value.slice("keychain:".length) : "")),
  keychainRef: vi.fn((account: string) => `keychain:${account}`),
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));
vi.mock("../utils/keychain.js", () => keychainMock);

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
// Build config paths exactly as config.ts does (join → platform separators);
// hand-built forward-slash paths never match CONFIG_PATH on Windows.
const { join } = await import("node:path");

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    readFile.mockReset();
    writeFile.mockReset();
    // Migration-lock primitives: default to a successfully acquired, non-stale lock.
    vi.mocked(fs.open).mockReset().mockResolvedValue(lockHandle as any);
    vi.mocked(fs.stat).mockReset().mockResolvedValue({ mtimeMs: Date.now() } as any);
    vi.mocked(fs.rename).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockReset().mockResolvedValue(undefined);
    lockState.token = "";
    lockHandle.writeFile.mockClear().mockImplementation(async (data: string) => { lockState.token = data; });
    lockHandle.close.mockClear().mockResolvedValue(undefined);
    keychainMock.isStoreUnresponsive.mockReset().mockReturnValue(false);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OLLAMA_ENDPOINT;
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_PORT;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.VERTEX_AI_CREDENTIALS_PATH;
    delete process.env.VERTEX_AI_LOCATION;
    delete process.env.AGAV_ORG_CONFIG;
    // Restore default keychain behaviour (unavailable; stable passthrough
    // helpers) after resetAllMocks clears implementations between tests.
    keychainMock.isKeychainAvailable.mockReset().mockResolvedValue(false);
    keychainMock.getSecret.mockReset().mockResolvedValue(undefined);
    keychainMock.setSecret.mockReset().mockResolvedValue(true);
    keychainMock.deleteSecret.mockReset().mockResolvedValue(undefined);
    keychainMock.isKeychainRef.mockImplementation((value: string) => value.startsWith("keychain:"));
    keychainMock.keychainAccount.mockImplementation((value: string) => (value.startsWith("keychain:") ? value.slice("keychain:".length) : ""));
    keychainMock.keychainRef.mockImplementation((account: string) => `keychain:${account}`);
  });

  // Reset encrypt mocks to defaults before each test; some tests override decrypt
  // to emulate an undecryptable value and must not leak into others.
  beforeEach(async () => {
    const encryptMod = await import("../utils/encrypt.js");
    vi.mocked(encryptMod.encrypt).mockImplementation((value: string) => `enc:${value}`);
    vi.mocked(encryptMod.decrypt).mockImplementation((value: string) => (value.startsWith("enc:") ? value.slice(4) : value));
    vi.mocked(encryptMod.isEncrypted).mockImplementation((value: string) => value.startsWith("enc:"));
  });

  it("accepts valid effort levels", async () => {
    const mod = await import("../config/config.js");
    expect(mod.isEffortLevel("minimal")).toBe(true);
    expect(mod.isEffortLevel("low")).toBe(true);
    expect(mod.isEffortLevel("max")).toBe(true);
    expect(mod.isEffortLevel("super-high")).toBe(false);
    expect(mod.EFFORT_LEVELS).toEqual(["minimal", "low", "medium", "high", "max"]);
    expect(mod.PROJECT_CONFIG_TEMPLATE.effort.enum).toEqual(["minimal", "low", "medium", "high", "max"]);
  });

  it("falls back to defaults for invalid config values", async () => {
    readFile.mockImplementation(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const result = await mod.loadConfig();

    expect(result.maxIterations).toBe(800);
    expect(result.errorRetries).toBe(5);
    expect(result.effort).toBe("high");
    expect(result.provider).toBe("anthropic");
    expect(result.permissionMode).toBe("ask");
  });

  it("loads minimal effort from config file and rejects invalid effort", async () => {
    const mod = await import("../config/config.js");

    readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("config.json")) {
        return JSON.stringify({ effort: "minimal" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const minimalConfig = await mod.loadConfig();
    expect(minimalConfig.effort).toBe("minimal");

    readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("config.json")) {
        return JSON.stringify({ effort: "invalid-effort" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const invalidConfig = await mod.loadConfig();
    expect(invalidConfig.effort).toBe("high");
  });

  it("refreshes the project config template without changing user settings", async () => {
    const userConfig = {
      provider: "ollama",
      model: "custom-model",
      customSetting: { keep: true },
      template: { provider: { enum: ["legacy-provider"] } },
    };

    readFile.mockImplementation(async (path: any) => {
      if (/[\\/]\.agav[\\/]config\.json$/.test(String(path))) {
        return JSON.stringify(userConfig);
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    await mod.loadConfig();

    expect(writeFile).toHaveBeenCalledTimes(1);
    const updated = JSON.parse(String(writeFile.mock.calls[0]?.[1]));
    expect(updated).toMatchObject({
      provider: "ollama",
      model: "custom-model",
      customSetting: { keep: true },
    });
    expect(updated.template.provider.enum).toContain("openrouter");
    expect(updated.template.provider.enum).not.toContain("legacy-provider");
  });

  it("does not rewrite the project config when its template is current", async () => {
    let projectContents: string | undefined;
    readFile.mockImplementation(async (path: any) => {
      if (/[\\/]\.agav[\\/]config\.json$/.test(String(path)) && projectContents !== undefined) {
        return projectContents;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    writeFile.mockImplementation(async (_path: any, contents: any) => {
      projectContents = String(contents);
    });

    const mod = await import("../config/config.js");
    await mod.loadConfig();
    expect(writeFile).toHaveBeenCalledTimes(1);

    await mod.loadConfig();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("loads project-level secrets when env vars are absent", async () => {
    readFile.mockImplementation(async (path: any) => {
      const s = String(path);
      if (/[\\/]\.agav[\\/]config\.json$/.test(s)) {
        return JSON.stringify({
          anthropicApiKey: "enc:anthropic-project",
          openaiApiKey: "enc:openai-project",
          openrouterApiKey: "enc:openrouter-project",
          geminiApiKey: "enc:gemini-project",
          ollamaApiKey: "enc:ollama-project",
        });
      }
      if (/[\\/]config\.json$/.test(s)) {
        return JSON.stringify({
          anthropicApiKey: "enc:anthropic-global",
          openaiApiKey: "enc:openai-global",
          openrouterApiKey: "enc:openrouter-global",
          geminiApiKey: "enc:gemini-global",
          ollamaApiKey: "enc:ollama-global",
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const loaded = await mod.loadConfig();

    expect(loaded.anthropicApiKey).toBe("anthropic-project");
    expect(loaded.openaiApiKey).toBe("openai-project");
    expect(loaded.openrouterApiKey).toBe("openrouter-project");
    expect(loaded.geminiApiKey).toBe("gemini-project");
    expect(loaded.ollamaApiKey).toBe("ollama-project");
  });

  // No shell is involved when config.json is read back, so a `~` written there
  // would otherwise reach fs.readFile literally and fail with ENOENT.
  it("expands a leading ~ in the Vertex AI credentials path", async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");

    readFile.mockImplementation(async (path: any) => {
      if (/[\\/]\.agav[\\/]config\.json$/.test(String(path))) {
        return JSON.stringify({ vertexAICredentialsPath: "~/.gcp/sa.json" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const loaded = await mod.loadConfig();

    expect(loaded.vertexAICredentialsPath).toBe(join(homedir(), ".gcp/sa.json"));
  });

  it("expands ~ from the env var and leaves absolute paths untouched", async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    process.env.VERTEX_AI_CREDENTIALS_PATH = "~/keys/sa.json";

    readFile.mockImplementation(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    expect((await mod.loadConfig()).vertexAICredentialsPath).toBe(join(homedir(), "keys/sa.json"));

    expect(mod.expandHome("/absolute/sa.json")).toBe("/absolute/sa.json");
    expect(mod.expandHome("relative/~/sa.json")).toBe("relative/~/sa.json");
    expect(mod.expandHome("~")).toBe(homedir());
  });

  it("strips sensitive org-tier fields from untrusted project config", async () => {
    // A cloned repository must not be able to redirect enrollment or declare
    // itself in-policy via .agav/config.json.
    const { join } = await import("node:path");
    const projectConfigPath = join(process.cwd(), ".agav", "config.json");
    readFile.mockImplementation(async (path: any) => {
      if (String(path) === projectConfigPath) {
        return JSON.stringify({
          controlPlane: "https://attacker.example",
          // A repo must not be able to redirect audit events to its own sink.
          auditSink: "https://attacker.example/collect",
          orgAllowedModels: ["evil-model"],
          orgAllowedProviders: ["ollama"],
          orgManagedProvider: "ollama",
          orgManagedModel: "attacker-forced",
          orgPermissionFloor: "deny-writes",
          // A repo must not be able to forge the trusted gateway-auth marker to
          // pass credential validation with no key and no enrollment.
          openaiGatewayAuth: true,
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const loaded = await mod.loadConfig();

    expect(loaded.controlPlane).toBeUndefined();
    expect(loaded.auditSink).toBeUndefined();
    expect(loaded.orgAllowedModels).toBeUndefined();
    expect(loaded.orgAllowedProviders).toBeUndefined();
    // Derived managed-constraint fields must not be injectable by a project.
    expect(loaded.orgManagedProvider).toBeUndefined();
    expect(loaded.orgManagedModel).toBeUndefined();
    expect(loaded.orgPermissionFloor).toBeUndefined();
    // The trusted gateway-auth marker is reset unless set by real enrollment.
    expect(loaded.openaiGatewayAuth).toBeUndefined();
  });

  it("applies env overrides and encrypts secrets on save", async () => {
    process.env.ANTHROPIC_API_KEY = "enc:anthropic-env";
    process.env.OPENAI_API_KEY = "enc:openai-env";
    process.env.OPENROUTER_API_KEY = "enc:openrouter-env";
    process.env.GEMINI_API_KEY = "enc:gemini-env";
    process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
    process.env.OLLAMA_HOST = "127.0.0.1";
    process.env.OLLAMA_PORT = "11435";
    process.env.OLLAMA_API_KEY = "enc:ollama-env";
    process.env.VERTEX_AI_CREDENTIALS_PATH = "/tmp/service-account.json";
    process.env.VERTEX_AI_LOCATION = "us-east5";

    readFile.mockImplementation(async (path: any) => {
      const s = String(path);
      if (s.includes("/config.json") && !s.includes(".agav/config.json")) {
        return JSON.stringify({
          anthropicApiKey: "enc:anthropic-file",
          openaiApiKey: "enc:openai-file",
          openrouterApiKey: "enc:openrouter-file",
          geminiApiKey: "enc:gemini-file",
          ollamaApiKey: "enc:ollama-file",
        });
      }
      if (s.endsWith("/.agav/config.json") || s.includes("/.agav/config.json")) {
        return JSON.stringify({});
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const loaded = await mod.loadConfig();

    expect(loaded.anthropicApiKey).toBe("anthropic-env");
    expect(loaded.openaiApiKey).toBe("openai-env");
    expect(loaded.openrouterApiKey).toBe("openrouter-env");
    expect(loaded.geminiApiKey).toBe("gemini-env");
    expect(loaded.ollamaApiKey).toBe("ollama-env");
    expect(loaded.ollamaEndpoint).toBe("http://localhost:11434");
    expect(loaded.ollamaHost).toBe("127.0.0.1");
    expect(loaded.ollamaPort).toBe(11435);
    expect(loaded.vertexAICredentialsPath).toBe("/tmp/service-account.json");
    expect(loaded.vertexAILocation).toBe("us-east5");

    await mod.saveConfig({
      provider: "anthropic",
      model: "m",
      effort: "low",
      maxTokens: 1,
      maxIterations: 2,
      errorRetries: 3,
      permissionMode: "ask",
      anthropicApiKey: "a",
      openaiApiKey: "o",
      openrouterApiKey: "r",
      geminiApiKey: "g",
      ollamaApiKey: "l",
    });

    const body = String(writeFile.mock.calls.at(-1)?.[1]);
    expect(body).toContain("enc:a");
    expect(body).toContain("enc:o");
    expect(body).toContain("enc:r");
    expect(body).toContain("enc:g");
    expect(body).toContain("enc:l");
  });

  it("applies -c overrides over a loaded config, schema-validates them, and never persists them", async () => {
    const overrides = await import("../config/cli-overrides.js");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      readFile.mockImplementation(async (path: any) => {
        if (String(path).endsWith("config.json")) {
          return JSON.stringify({ effort: "low", maxIterations: 100 });
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      });

      const mod = await import("../config/config.js");
      const loaded = await mod.loadConfig();
      expect(loaded.effort).toBe("low");

      overrides.applyConfigOverrides(loaded, [overrides.parseConfigOverride("effort=high")]);
      expect(loaded.effort).toBe("high");

      // Unknown key and value outside the schema's enum are rejected.
      expect(() => overrides.parseConfigOverride("efrot=high")).toThrow("exit");
      expect(() => overrides.parseConfigOverride("effort=nope")).toThrow("exit");

      const writesBefore = writeFile.mock.calls.length;
      overrides.applyConfigOverrides(loaded, [overrides.parseConfigOverride("maxIterations=42")]);
      expect(loaded.maxIterations).toBe(42);
      expect(writeFile.mock.calls.length).toBe(writesBefore);
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  it("registered session overrides apply to every later loadConfig() consumer", async () => {
    readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("config.json")) {
        return JSON.stringify({ backgroundJobsEnabled: true, agentMarketplace: "https://disk.example" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const overrides = await import("../config/cli-overrides.js");
    const entries = [
      overrides.parseConfigOverride("backgroundJobsEnabled=false"),
      overrides.parseConfigOverride("agentMarketplace=https://session.example"),
    ];
    mod.setSessionConfigOverrides({ entries, apply: (cfg) => overrides.applyConfigOverrides(cfg, entries) });

    // Fresh loadConfig() — the consumer pattern (run_background_job, marketplace).
    const consumerView = await mod.loadConfig();
    expect(consumerView.backgroundJobsEnabled).toBe(false);
    expect(consumerView.agentMarketplace).toBe("https://session.example");
    // The template write is loadConfig's only writer; no write may carry a session value.
    const writtenBodies = writeFile.mock.calls.map((call) => String(call[1]));
    expect(writtenBodies.every((body) => !body.includes("session.example"))).toBe(true);
    expect(writtenBodies.every((body) => !body.includes("\"backgroundJobsEnabled\": false"))).toBe(true);

    mod.setSessionConfigOverrides(undefined);
    expect((await mod.loadConfig()).backgroundJobsEnabled).toBe(true);
  });

  it("org policy still outranks a registered session override inside loadConfig", async () => {
    process.env.AGAV_ORG_CONFIG = "/org/org-config.json";
    readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p === "/org/org-config.json") return JSON.stringify({ provider: "openai", model: "gpt-org" });
      if (p.endsWith("config.json")) return JSON.stringify({});
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const overrides = await import("../config/cli-overrides.js");
    const entries = [
      overrides.parseConfigOverride("provider=ollama"),
      overrides.parseConfigOverride("model=llama3"),
    ];
    mod.setSessionConfigOverrides({ entries, apply: (cfg) => overrides.applyConfigOverrides(cfg, entries) });

    const loaded = await mod.loadConfig();
    expect(loaded.provider).toBe("openai");
    expect(loaded.model).toBe("gpt-org");
  });

  it("saveConfig never persists a session override, restoring the stored value instead", async () => {
    readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("config.json")) return JSON.stringify({ effort: "low" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const overrides = await import("../config/cli-overrides.js");
    const entries = [overrides.parseConfigOverride("effort=high")];
    mod.setSessionConfigOverrides({ entries, apply: (cfg) => overrides.applyConfigOverrides(cfg, entries) });

    const loaded = await mod.loadConfig();
    expect(loaded.effort).toBe("high");

    // Saving the session config must write disk's stored value, not the override.
    await mod.saveConfig(loaded);
    const written = JSON.parse(String(writeFile.mock.calls.at(-1)?.[1]));
    expect(written.effort).toBe("low");

    // Override absent on disk: dropped, not added.
    readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("config.json")) return JSON.stringify({});
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const entries2 = [overrides.parseConfigOverride("agentMarketplace=https://session.example")];
    mod.setSessionConfigOverrides({ entries: entries2, apply: (cfg) => overrides.applyConfigOverrides(cfg, entries2) });
    const loaded2 = await mod.loadConfig();
    expect(loaded2.agentMarketplace).toBe("https://session.example");
    await mod.saveConfig(loaded2);
    const written2 = JSON.parse(String(writeFile.mock.calls.at(-1)?.[1]));
    expect(written2.agentMarketplace).toBeUndefined();
  });

  it("expands a raw ~ in a session-overridden vertexAICredentialsPath", async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("config.json")) return JSON.stringify({});
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const overrides = await import("../config/cli-overrides.js");
    const entries = [overrides.parseConfigOverride("vertexAICredentialsPath=~/.gcp/sa.json")];
    mod.setSessionConfigOverrides({ entries, apply: (cfg) => overrides.applyConfigOverrides(cfg, entries) });

    const loaded = await mod.loadConfig();
    expect(loaded.vertexAICredentialsPath).toBe(join(homedir(), ".gcp/sa.json"));
    mod.setSessionConfigOverrides(undefined);
  });

  it("stores secrets in the OS credential store and writes only placeholders when available", async () => {
    keychainMock.isKeychainAvailable.mockResolvedValue(true);
    keychainMock.setSecret.mockResolvedValue(true);
    // No existing on-disk config.
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const mod = await import("../config/config.js");
    await mod.saveConfig({
      provider: "anthropic", model: "m", effort: "low", maxTokens: 1, maxIterations: 2,
      errorRetries: 3, permissionMode: "ask",
      anthropicApiKey: "a-secret", openaiApiKey: "o-secret",
    });

    const body = String(writeFile.mock.calls.at(-1)?.[1]);
    // The plaintext and the enc: fallback must never touch the file when the
    // credential store accepted the secret.
    expect(body).not.toContain("a-secret");
    expect(body).not.toContain("enc:");
    expect(body).toContain("keychain:anthropic-api-key");
    expect(body).toContain("keychain:openai-api-key");
    expect(keychainMock.setSecret).toHaveBeenCalledWith("anthropic-api-key", "a-secret");
    expect(keychainMock.setSecret).toHaveBeenCalledWith("openai-api-key", "o-secret");
  });

  it("falls back to in-file encryption when a credential-store write fails", async () => {
    keychainMock.isKeychainAvailable.mockResolvedValue(true);
    keychainMock.setSecret.mockResolvedValue(false);
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const mod = await import("../config/config.js");
    await mod.saveConfig({
      provider: "anthropic", model: "m", effort: "low", maxTokens: 1, maxIterations: 2,
      errorRetries: 3, permissionMode: "ask", anthropicApiKey: "a-secret",
    });

    const body = String(writeFile.mock.calls.at(-1)?.[1]);
    expect(body).toContain("enc:a-secret");
    expect(body).not.toContain("keychain:");
  });

  it("does NOT delete a stored secret when a key field is merely absent on save", async () => {
    // A transient keychain read failure during loadConfig can leave a key
    // undefined; saving then must preserve the stored secret, not destroy it.
    keychainMock.isKeychainAvailable.mockResolvedValue(true);
    readFile.mockResolvedValue(JSON.stringify({ anthropicApiKey: "keychain:anthropic-api-key" }));

    const mod = await import("../config/config.js");
    await mod.saveConfig({
      provider: "anthropic", model: "m", effort: "low", maxTokens: 1, maxIterations: 2,
      errorRetries: 3, permissionMode: "ask", anthropicApiKey: undefined,
    });

    expect(keychainMock.deleteSecret).not.toHaveBeenCalled();
    const body = String(writeFile.mock.calls.at(-1)?.[1]);
    // The existing placeholder is preserved verbatim.
    expect(body).toContain("keychain:anthropic-api-key");
  });

  it("clearStoredApiKey deletes the stored secret and drops the field", async () => {
    keychainMock.isKeychainAvailable.mockResolvedValue(true);
    keychainMock.deleteSecret.mockResolvedValue(undefined);
    readFile.mockResolvedValue(JSON.stringify({ anthropicApiKey: "keychain:anthropic-api-key", provider: "anthropic" }));

    const mod = await import("../config/config.js");
    await mod.clearStoredApiKey("anthropicApiKey");

    expect(keychainMock.deleteSecret).toHaveBeenCalledWith("anthropic-api-key");
    const body = String(writeFile.mock.calls.at(-1)?.[1]);
    expect(body).not.toContain("anthropicApiKey");
    expect(body).toContain("\"provider\": \"anthropic\"");
  });

  it("exclusively creates and releases its lock without renaming it", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const mod = await import("../config/config.js");
    await mod.saveConfig({
      provider: "anthropic", model: "m", effort: "low", maxTokens: 1, maxIterations: 2,
      errorRetries: 3, permissionMode: "ask",
    });
    expect(fs.open).toHaveBeenCalledWith(expect.stringContaining(".config.lock"), "wx", 0o600);
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".config.lock"));
    expect(vi.mocked(fs.rename).mock.calls.every(([from, to]) =>
      !String(from).includes(".config.lock") && !String(to).includes(".config.lock"),
    )).toBe(true);
  });

  it("never reclaims an old lock, including simultaneous migration attempts", async () => {
    readFile.mockResolvedValue(JSON.stringify({ openaiApiKey: "enc:synthetic" }));
    vi.mocked(fs.open).mockRejectedValue(Object.assign(new Error("exists"), { code: "EEXIST" }));
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: 0 } as any);
    const mod = await import("../config/config.js");
    expect(await Promise.all([mod.migrateSecretsToKeychain(), mod.migrateSecretsToKeychain()])).toEqual([0, 0]);
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(keychainMock.setSecret).not.toHaveBeenCalled();
  });

  it("holds the in-process mutex throughout a slow migration and its release", async () => {
    vi.useFakeTimers();
    try {
      let disk = JSON.stringify({ openaiApiKey: "enc:synthetic" });
      readFile.mockImplementation(async () => disk);
      writeFile.mockImplementation(async (_path, data) => { disk = String(data); });
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      let finish!: (result: boolean) => void;
      let entered!: () => void;
      const storing = new Promise<void>(resolve => { entered = resolve; });
      keychainMock.setSecret.mockImplementation(() => {
        entered();
        return new Promise<boolean>(resolve => { finish = resolve; });
      });
      const mod = await import("../config/config.js");
      const migration = mod.migrateSecretsToKeychain();
      await storing;
      const layout = [{ id: "model" as const, enabled: true }];
      const saving = mod.saveStatusBarLayout(layout);
      // Longer than the cross-process lock wait, but still a normal migration.
      await vi.advanceTimersByTimeAsync(6000);
      expect(fs.open).toHaveBeenCalledTimes(1);
      expect(writeFile).not.toHaveBeenCalled();
      finish(true);
      await expect(migration).resolves.toBe(1);
      await expect(saving).resolves.toBeUndefined();
      expect(JSON.parse(disk)).toEqual({ openaiApiKey: "keychain:openai-api-key", statusBar: layout });
      expect(fs.open).toHaveBeenCalledTimes(2);
      const opens = vi.mocked(fs.open).mock.invocationCallOrder;
      const releases = vi.mocked(fs.unlink).mock.invocationCallOrder;
      expect(opens[1]).toBeGreaterThan(releases[0]!);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes and releases an acquired lock when writing its PID fails", async () => {
    lockHandle.writeFile.mockRejectedValueOnce(new Error("disk full"));
    const mod = await import("../config/config.js");
    await expect(mod.saveStatusBarLayout(undefined)).rejects.toThrow("disk full");
    expect(lockHandle.close).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(".config.lock"));
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("fails closed (throws) when the config lock cannot be acquired", async () => {
    vi.useFakeTimers();
    // Lock perpetually held by a live peer: open → EEXIST, stat → fresh mtime.
    vi.mocked(fs.open).mockRejectedValue(Object.assign(new Error("exists"), { code: "EEXIST" }));
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: Date.now() } as any);
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const mod = await import("../config/config.js");
    const p = mod.saveConfig({
      provider: "anthropic", model: "m", effort: "low", maxTokens: 1, maxIterations: 2,
      errorRetries: 3, permissionMode: "ask",
    });
    const assertion = expect(p).rejects.toThrow(/config lock/i);
    await vi.advanceTimersByTimeAsync(6000); // exceed CONFIG_LOCK_WAIT_MS
    await assertion;
    // Must NOT have written the config without the lock.
    expect(writeFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a blocking writer waits for a live lock, then proceeds once it frees", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    // First open() attempt: lock held by a live peer (EEXIST + fresh mtime).
    // Second attempt (after a poll): lock is free and acquired.
    let held = true;
    vi.mocked(fs.open).mockImplementation(async (p: any, flags: any) => {
      if (String(p).endsWith(".config.lock") && flags === "wx" && held) {
        held = false; // peer releases before the next poll
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      return lockHandle as any;
    });
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: Date.now() } as any); // fresh → live peer

    const mod = await import("../config/config.js");
    await mod.saveConfig({
      provider: "anthropic", model: "m", effort: "low", maxTokens: 1, maxIterations: 2,
      errorRetries: 3, permissionMode: "ask",
    });
    // Despite initial contention, the save eventually wrote the config.
    expect(writeFile).toHaveBeenCalled();
  });

  it("resolves keychain placeholders from the OS store on load", async () => {
    keychainMock.getSecret.mockImplementation(async (account: string) =>
      account === "anthropic-api-key" ? "resolved-anthropic" : undefined,
    );

    const { homedir } = await import("node:os");
    const globalPath = join(homedir(), ".agav", "config.json");
    readFile.mockImplementation(async (path: any) => {
      if (String(path) === globalPath) {
        return JSON.stringify({ anthropicApiKey: "keychain:anthropic-api-key" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const loaded = await mod.loadConfig();
    expect(loaded.anthropicApiKey).toBe("resolved-anthropic");
  });

  it("reports a missing key (never the placeholder) when the store cannot resolve it", async () => {
    keychainMock.getSecret.mockResolvedValue(undefined);

    const { homedir } = await import("node:os");
    const globalPath = join(homedir(), ".agav", "config.json");
    readFile.mockImplementation(async (path: any) => {
      if (String(path) === globalPath) {
        return JSON.stringify({ anthropicApiKey: "keychain:anthropic-api-key" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const loaded = await mod.loadConfig();
    expect(loaded.anthropicApiKey).toBeUndefined();
  });

  it("treats an undecryptable enc: stored key as missing, not as a raw key", async () => {
    const encryptMod = await import("../utils/encrypt.js");
    vi.mocked(encryptMod.decrypt).mockImplementation((v: string) =>
      v === "enc:broken" ? "enc:broken" : (v.startsWith("enc:") ? v.slice(4) : v),
    );
    const { homedir } = await import("node:os");
    const globalPath = join(homedir(), ".agav", "config.json");
    readFile.mockImplementation(async (path: any) => {
      if (String(path) === globalPath) return JSON.stringify({ anthropicApiKey: "enc:broken" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const loaded = await mod.loadConfig();
    // Must NOT surface the raw "enc:broken" ciphertext as the API key.
    expect(loaded.anthropicApiKey).toBeUndefined();
  });

  describe("model discovery credential recovery", () => {
    async function loadUnresolved() {
      const mod = await import("../config/config.js");
      const globalPath = join(mod.getAgavDir(), "config.json");
      const disk = { openaiApiKey: "keychain:openai-api-key" };
      readFile.mockImplementation(async (path: any) => {
        if (String(path) === globalPath) return JSON.stringify(disk);
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      });
      keychainMock.getSecret.mockResolvedValue(undefined);
      const loaded = await mod.loadConfig();
      expect(loaded.openaiApiKey).toBeUndefined();
      return { mod, loaded, disk };
    }

    it("retries discovery after startup failure without a restart or settings reload", async () => {
      const { loaded } = await loadUnresolved();
      // Model/provider changes in App use object spread. Recovery provenance must
      // survive that copy while remaining absent from JSON exports/config writes.
      const session = { ...loaded, model: "session-only", effort: "low" as const };
      expect(JSON.stringify(session)).not.toContain("keychain:");
      const { fetchAvailableModels } = await import("../commands/model.js");
      const fetchMock = vi.fn(async (url: any, options?: any) => {
        if (String(url).startsWith("https://api.openai.com/")) {
          expect(options.headers.Authorization).toBe("Bearer synthetic-recovered-key");
          return { ok: true, json: async () => ({ data: [{ id: "gpt-4o" }] }) } as Response;
        }
        throw new Error("unreachable fixture endpoint");
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        // Still in cooldown: discovery returns a safe, actionable warning.
        const unavailable = await fetchAvailableModels(session);
        expect(unavailable.warnings.join(" ")).toContain("retry /model");
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.openai.com"))).toBe(false);
        keychainMock.getSecret.mockResolvedValue("synthetic-recovered-key");
        const recovered = await fetchAvailableModels(session);
        expect(recovered.models).toContainEqual(expect.objectContaining({ id: "gpt-4o", provider: "openai" }));
        expect(recovered.warnings).toEqual([]);
        expect(session.openaiApiKey).toBe("synthetic-recovered-key");
        expect(session.model).toBe("session-only");
        expect(session.effort).toBe("low");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not resurrect a cleared or replaced stored reference", async () => {
      const { mod, loaded, disk } = await loadUnresolved();
      disk.openaiApiKey = "keychain:replacement";
      keychainMock.getSecret.mockClear().mockResolvedValue("synthetic-old-key");
      await mod.refreshStoredApiKeys(loaded);
      expect(keychainMock.getSecret).not.toHaveBeenCalled();
      expect(loaded.openaiApiKey).toBeUndefined();
      disk.openaiApiKey = "keychain:openai-api-key";
      keychainMock.getSecret.mockImplementation(async () => {
        delete (disk as Partial<typeof disk>).openaiApiKey;
        return "synthetic-old-key";
      });
      await mod.refreshStoredApiKeys(loaded);
      expect(loaded.openaiApiKey).toBeUndefined();
    });

    it("queues recovery behind a same-account credential rotation", async () => {
      const { mod, loaded, disk } = await loadUnresolved();
      let finish!: (ok: boolean) => void;
      let entered!: () => void;
      const storing = new Promise<void>(resolve => { entered = resolve; });
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      keychainMock.setSecret.mockImplementation(() => {
        entered();
        return new Promise<boolean>(resolve => { finish = resolve; });
      });
      keychainMock.getSecret.mockClear().mockResolvedValue("synthetic-rotated-key");
      const save = mod.saveConfig({ ...loaded, openaiApiKey: "synthetic-rotated-key" });
      await storing;
      const retry = mod.refreshStoredApiKeys(loaded);
      await Promise.resolve();
      expect(keychainMock.getSecret).not.toHaveBeenCalled();
      finish(true);
      await save;
      await retry;
      expect(disk.openaiApiKey).toBe("keychain:openai-api-key");
      expect(loaded.openaiApiKey).toBe("synthetic-rotated-key");
    });

    it("preserves explicit credentials and empty environment overrides", async () => {
      const { mod, loaded } = await loadUnresolved();
      keychainMock.getSecret.mockClear().mockResolvedValue("synthetic-stored-key");
      loaded.openaiApiKey = "session-key";
      await mod.refreshStoredApiKeys(loaded);
      expect(loaded.openaiApiKey).toBe("session-key");
      loaded.openaiApiKey = undefined;
      vi.stubEnv("OPENAI_API_KEY", "");
      try {
        await mod.refreshStoredApiKeys(loaded);
        expect(loaded.openaiApiKey).toBeUndefined();
        expect(keychainMock.getSecret).not.toHaveBeenCalled();
        const envOverride = await mod.loadConfig();
        vi.unstubAllEnvs();
        await mod.refreshStoredApiKeys(envOverride);
        expect(envOverride.openaiApiKey).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("migrateSecretsToKeychain", () => {
    it("does nothing when no credential store is available", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(false);
      readFile.mockResolvedValue(JSON.stringify({ anthropicApiKey: "enc:a-secret" }));
      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(0);
      expect(keychainMock.setSecret).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("moves in-file enc: secrets into the store and rewrites only placeholders", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      keychainMock.setSecret.mockResolvedValue(true);
      readFile.mockResolvedValue(JSON.stringify({
        provider: "anthropic",
        anthropicApiKey: "enc:a-secret",
        openaiApiKey: "enc:o-secret",
        statusBar: { segments: ["model"] },
      }));

      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(2);
      expect(keychainMock.setSecret).toHaveBeenCalledWith("anthropic-api-key", "a-secret");
      expect(keychainMock.setSecret).toHaveBeenCalledWith("openai-api-key", "o-secret");

      // The rewrite stages to a temp path; assert on that content.
      const body = String(writeFile.mock.calls.at(-1)?.[1]);
      expect(body).not.toContain("a-secret");
      expect(body).not.toContain("enc:");
      expect(body).toContain("keychain:anthropic-api-key");
      expect(body).toContain("keychain:openai-api-key");
      // Unrelated keys are preserved verbatim.
      expect(body).toContain("\"provider\": \"anthropic\"");
      expect(body).toContain("statusBar");
    });

    it("is idempotent: already-migrated keychain: refs are left untouched", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      readFile.mockResolvedValue(JSON.stringify({
        anthropicApiKey: "keychain:anthropic-api-key",
      }));
      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(0);
      expect(keychainMock.setSecret).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      // Steady-state guarantee: with nothing to move, the OS store is never even
      // probed, so startup spawns no credential-store subprocess.
      expect(keychainMock.isKeychainAvailable).not.toHaveBeenCalled();
    });

    it("leaves a key in the file as enc: when its store write fails", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      keychainMock.setSecret.mockImplementation(async (account: string) =>
        account === "anthropic-api-key" ? true : false,
      );
      readFile.mockResolvedValue(JSON.stringify({
        anthropicApiKey: "enc:a-secret",
        openaiApiKey: "enc:o-secret",
      }));

      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(1);
      const body = String(writeFile.mock.calls.at(-1)?.[1]);
      expect(body).toContain("keychain:anthropic-api-key");
      // The failed key keeps its encrypted in-file value — never lost.
      expect(body).toContain("enc:o-secret");
    });

    it("skips an undecryptable enc: value rather than storing it as a bogus secret", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      keychainMock.setSecret.mockResolvedValue(true);
      // decrypt() (mocked) returns input unchanged when it does not start with
      // enc:. A value that stays "enc:..." after decrypt is an undecryptable
      // ciphertext; make the mock emulate that for this specific value.
      const encryptMod = await import("../utils/encrypt.js");
      vi.mocked(encryptMod.decrypt).mockImplementation((v: string) =>
        v === "enc:broken" ? "enc:broken" : (v.startsWith("enc:") ? v.slice(4) : v),
      );
      readFile.mockResolvedValue(JSON.stringify({
        anthropicApiKey: "enc:broken",   // cannot decrypt
        openaiApiKey: "enc:o-secret",     // fine
      }));

      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(1);
      // The broken one is never stored, and its field is left as-is in the file.
      expect(keychainMock.setSecret).not.toHaveBeenCalledWith("anthropic-api-key", expect.anything());
      expect(keychainMock.setSecret).toHaveBeenCalledWith("openai-api-key", "o-secret");
      const body = String(writeFile.mock.calls.at(-1)?.[1]);
      expect(body).toContain("enc:broken");
      expect(body).toContain("keychain:openai-api-key");
    });

    it("merges onto a concurrent edit instead of clobbering it", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      keychainMock.setSecret.mockResolvedValue(true);
      // Reads: (1) cheap preview, (2) snapshot under lock, (3) current state just
      // before the rewrite — now carrying a concurrent statusBar edit.
      const original = JSON.stringify({ anthropicApiKey: "enc:a-secret", statusBar: { segments: ["model"] } });
      readFile
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(JSON.stringify({ anthropicApiKey: "enc:a-secret", statusBar: { segments: ["model", "usage"] } }));

      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(1);
      const body = String(writeFile.mock.calls.at(-1)?.[1]);
      // The migrated key becomes a placeholder...
      expect(body).toContain("keychain:anthropic-api-key");
      // ...and the concurrent statusBar edit (usage) is preserved, not overwritten.
      expect(body).toContain("usage");
    });

    it("does not overwrite a key the user rotated during the migration window", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      keychainMock.setSecret.mockResolvedValue(true);
      // Reads: preview + snapshot have the old secret; the final read sees the
      // user's concurrently-rotated secret, so the placeholder is NOT applied.
      const old = JSON.stringify({ anthropicApiKey: "enc:old-secret" });
      readFile
        .mockResolvedValueOnce(old)
        .mockResolvedValueOnce(old)
        .mockResolvedValueOnce(JSON.stringify({ anthropicApiKey: "enc:new-secret" }));

      const mod = await import("../config/config.js");
      // Stored the old secret, but the field changed, so no file field is applied.
      expect(await mod.migrateSecretsToKeychain()).toBe(1);
      // No write occurs because applied === 0 (field value differs from snapshot).
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("skips migration when a live peer holds the lock", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      keychainMock.setSecret.mockResolvedValue(true);
      readFile.mockResolvedValue(JSON.stringify({ anthropicApiKey: "enc:a-secret" }));
      // open() fails EEXIST and the existing lock is fresh (live peer).
      vi.mocked(fs.open).mockRejectedValue(Object.assign(new Error("exists"), { code: "EEXIST" }));
      vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: Date.now() } as any);

      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(0);
      expect(keychainMock.setSecret).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("does not commit a placeholder when the store write trips the breaker (timeout)", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      // setSecret appears to succeed, but the store became unresponsive during
      // the call — committing the placeholder would orphan the key this session.
      keychainMock.setSecret.mockResolvedValue(true);
      keychainMock.isStoreUnresponsive.mockReturnValue(true);
      readFile.mockResolvedValue(JSON.stringify({ anthropicApiKey: "enc:a-secret" }));

      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(0);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("does not rewrite the file or probe the store when there is nothing to migrate", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      readFile.mockResolvedValue(JSON.stringify({ provider: "anthropic", model: "m" }));
      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(0);
      expect(writeFile).not.toHaveBeenCalled();
      // No in-file secret → no subprocess spawn to detect the credential store.
      expect(keychainMock.isKeychainAvailable).not.toHaveBeenCalled();
    });

    it("never throws and returns 0 on a corrupt or missing config file", async () => {
      keychainMock.isKeychainAvailable.mockResolvedValue(true);
      readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
      const mod = await import("../config/config.js");
      expect(await mod.migrateSecretsToKeychain()).toBe(0);
      expect(writeFile).not.toHaveBeenCalled();

      readFile.mockResolvedValue("{ not json");
      expect(await mod.migrateSecretsToKeychain()).toBe(0);
      expect(writeFile).not.toHaveBeenCalled();
    });
  });
});
