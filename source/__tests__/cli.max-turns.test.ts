import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../main.js";
import { loadConfig, type AgavConfig } from "../config/config.js";
import { createProvider } from "../providers/registry.js";

vi.mock("../config/config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config/config.js")>(),
  loadConfig: vi.fn(),
}));
vi.mock("../config/keybindings.js", () => ({ loadKeybindings: vi.fn(async () => ({})) }));
vi.mock("../config/theme.js", () => ({ loadTheme: vi.fn() }));
vi.mock("../config/history.js", () => ({ listSessions: vi.fn(async () => []) }));
vi.mock("../providers/registry.js", () => ({ createProvider: vi.fn() }));
vi.mock("../utils/auto-update.js", () => ({ checkAndUpdate: vi.fn() }));
vi.mock("../utils/temp-output.js", () => ({ tempOutputManager: { pruneStale: vi.fn() } }));

const originalArgv = process.argv;
const exitError = new Error("process exited");
const providerReached = new Error("provider reached");
let config: AgavConfig;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation(() => { throw exitError; });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  config = {
    provider: "anthropic", model: "configured-model", anthropicApiKey: "test-key",
    effort: "medium", maxTokens: 1024, maxIterations: 37, errorRetries: 1,
    permissionMode: "ask", systemPrompt: "test prompt",
  };
  vi.mocked(loadConfig).mockResolvedValue(config);
  vi.mocked(createProvider).mockImplementation(() => { throw providerReached; });
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

const invalidValues = ["", " ", "2.5", "10abc", "1e3", "0", "-5", "foo",
  "9007199254740992", "9007199254740993", "0x10", "+2", "1 2"];

describe("--max-turns production CLI validation", () => {
  describe.each(["space", "equals"])("%s form", (form) => {
    const args = (value: string) => form === "space" ? ["--max-turns", value] : [`--max-turns=${value}`];

    it.each(["1", "10", " 42 ", "0002", "9007199254740991"])("accepts %j", (value) => {
      expect(parseArgs(args(value)).maxTurns).toBe(Number(value));
      expect(process.exit).not.toHaveBeenCalled();
    });

    it.each(invalidValues)("rejects %j with an actionable error", (value) => {
      expect(() => parseArgs(args(value))).toThrow(exitError);
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("--max-turns must be a positive safe integer"));
    });
  });

  it.each([[], ["--help"], ["run", "--", "--max-turns=2.5"]])("leaves absent or literal flags unset: %j", (...args) => {
    expect(parseArgs(args).maxTurns).toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it.each([["--max-turns"], ["--max-turns", "--help"], ["--max-turns", "--"]])("rejects a missing value: %j", (...args) => {
    expect(() => parseArgs(args)).toThrow(exitError);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("--max-turns"));
  });

  it.each(["run", "-P"])("%s retains configuration fallback and applies explicit overrides", async (command) => {
    for (const [args, expected] of [[[], 37], [["--max-turns", "10"], 10], [["--max-turns=12"], 12]] as const) {
      config.maxIterations = 37;
      process.argv = [process.execPath, "agav", command, "hello", ...args];
      await expect(main()).rejects.toThrow(providerReached);
      expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ maxIterations: expected }));
    }
  });

  it.each([["--max-turns"], ["--max-turns="], ["--max-turns=2.5"]])("fails before loading config or executing an agent: %j", async (...args) => {
    process.argv = [process.execPath, "agav", "run", "hello", ...args];
    await expect(main()).rejects.toThrow(exitError);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });
});
