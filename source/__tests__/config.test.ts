import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("../utils/fs.js", () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/encrypt.js", () => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => (value.startsWith("enc:") ? value.slice(4) : value)),
}));

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    readFile.mockReset();
    writeFile.mockReset();
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
});
