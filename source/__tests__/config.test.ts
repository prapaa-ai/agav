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
    delete process.env.GEMINI_API_KEY;
    delete process.env.OLLAMA_ENDPOINT;
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_PORT;
    delete process.env.OLLAMA_API_KEY;
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

  it("applies env overrides and encrypts secrets on save", async () => {
    process.env.ANTHROPIC_API_KEY = "enc:anthropic-env";
    process.env.OPENAI_API_KEY = "enc:openai-env";
    process.env.GEMINI_API_KEY = "enc:gemini-env";
    process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
    process.env.OLLAMA_HOST = "127.0.0.1";
    process.env.OLLAMA_PORT = "11435";
    process.env.OLLAMA_API_KEY = "enc:ollama-env";

    readFile.mockImplementation(async (path: any) => {
      const s = String(path);
      if (s.includes("/config.json") && !s.includes(".agav/config.json")) {
        return JSON.stringify({ anthropicApiKey: "enc:anthropic-file", openaiApiKey: "enc:openai-file", geminiApiKey: "enc:gemini-file", ollamaApiKey: "enc:ollama-file" });
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
    expect(loaded.geminiApiKey).toBe("gemini-env");
    expect(loaded.ollamaApiKey).toBe("ollama-env");
    expect(loaded.ollamaEndpoint).toBe("http://localhost:11434");
    expect(loaded.ollamaHost).toBe("127.0.0.1");
    expect(loaded.ollamaPort).toBe(11435);

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
      geminiApiKey: "g",
      ollamaApiKey: "l",
    });

    const body = String(writeFile.mock.calls.at(-1)?.[1]);
    expect(body).toContain("enc:a");
    expect(body).toContain("enc:o");
    expect(body).toContain("enc:g");
    expect(body).toContain("enc:l");
  });
});