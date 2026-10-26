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

  it("serializes writers through the shared config lock (acquire + release)", async () => {
    // Release reads the lock file to verify OUR token before unlinking it, so the
    // lock-path read must return the token the handle captured; other reads miss.
    readFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith(".config.lock")) return lockState.token;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const mod = await import("../config/config.js");
    await mod.saveConfig({
      provider: "anthropic", model: "m", effort: "low", maxTokens: 1, maxIterations: 2,
      errorRetries: 3, permissionMode: "ask",
    });
    // The lock is taken with an exclusive create ("wx") and released by unlinking it.
    const openCall = vi.mocked(fs.open).mock.calls.find((c) => String(c[0]).endsWith(".config.lock"));
    expect(openCall).toBeDefined();
    expect(openCall![1]).toBe("wx");
    expect(vi.mocked(fs.unlink).mock.calls.some((c) => String(c[0]).endsWith(".config.lock"))).toBe(true);
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
    const globalPath = `${homedir()}/.agav/config.json`;
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
    const globalPath = `${homedir()}/.agav/config.json`;
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
    const globalPath = `${homedir()}/.agav/config.json`;
    readFile.mockImplementation(async (path: any) => {
      if (String(path) === globalPath) return JSON.stringify({ anthropicApiKey: "enc:broken" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const mod = await import("../config/config.js");
    const loaded = await mod.loadConfig();
    // Must NOT surface the raw "enc:broken" ciphertext as the API key.
    expect(loaded.anthropicApiKey).toBeUndefined();
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
