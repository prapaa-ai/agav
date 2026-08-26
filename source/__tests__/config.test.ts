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
    delete process.env.GEMINI_API_KEY;
    delete process.env.OLLAMA_ENDPOINT;
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_PORT;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.VERTEX_AI_CREDENTIALS_PATH;
    delete process.env.VERTEX_AI_LOCATION;
  });

  it("accepts valid effort levels", async () => {
    const mod = await import("../config/config.js");
    expect(mod.isEffortLevel("low")).toBe(true);
    expect(mod.isEffortLevel("max")).toBe(true);
    expect(mod.isEffortLevel("super-high")).toBe(false);
    expect(mod.EFFORT_LEVELS).toEqual(["low", "medium", "high", "max"]);
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
});
