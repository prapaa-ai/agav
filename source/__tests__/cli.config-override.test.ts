import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../main.js";
import { loadConfig, type AgavConfig } from "../config/config.js";
import { loadOrgPolicy } from "../config/org-config.js";
import { createProvider } from "../providers/registry.js";
import { listSessions, loadSession } from "../config/history.js";
import {
  applyConfigOverrides,
  parseConfigOverride,
  type ConfigOverride,
} from "../config/cli-overrides.js";

vi.mock("../config/config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config/config.js")>(),
  loadConfig: vi.fn(),
}));
vi.mock("../config/keybindings.js", () => ({ loadKeybindings: vi.fn(async () => ({})) }));
vi.mock("../config/theme.js", () => ({ loadTheme: vi.fn() }));
vi.mock("../config/history.js", () => ({ listSessions: vi.fn(async () => []), loadSession: vi.fn() }));
vi.mock("../providers/registry.js", () => ({ createProvider: vi.fn() }));
vi.mock("../utils/auto-update.js", () => ({ checkAndUpdate: vi.fn() }));
vi.mock("../utils/temp-output.js", () => ({ tempOutputManager: { pruneStale: vi.fn() } }));
vi.mock("../config/org-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config/org-config.js")>(),
  loadOrgPolicy: vi.fn(async () => ({})),
}));

const originalArgv = process.argv;
const exitError = new Error("process exited");
const providerReached = new Error("provider reached");
let config: AgavConfig;

function overridesWith(argv: string[]): ConfigOverride[] {
  return parseArgs(argv).configOverrides as ConfigOverride[];
}

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
  vi.mocked(loadOrgPolicy).mockResolvedValue({});
  vi.mocked(createProvider).mockImplementation(() => { throw providerReached; });
});
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("-c/--config flag parsing", () => {
  it.each([
    { argv: ["-c", "effort=low"], expected: { path: ["effort"], value: "low" } },
    { argv: ["--config", "effort=low"], expected: { path: ["effort"], value: "low" } },
    { argv: ["--config=effort=low"], expected: { path: ["effort"], value: "low" } },
  ])("accepts $argv", ({ argv, expected }) => {
    expect(overridesWith(argv)).toEqual([expected]);
  });

  it("is repeatable and resolves a repeated key to the last occurrence", () => {
    const parsed = overridesWith(["-c", "effort=low", "-c", "effort=high"]);
    expect(parsed).toHaveLength(2);
    const target = { effort: "medium" } as unknown as AgavConfig;
    applyConfigOverrides(target, parsed);
    expect(target.effort).toBe("high");
  });

  it("splits on the first = so values may contain =", () => {
    expect(overridesWith(["-c", "systemPrompt=a=b=c"])[0]!.value).toBe("a=b=c");
    expect(overridesWith(["-c", 'openaiHeaders={"x-a":"b=c"}'])[0]!.value).toEqual({ "x-a": "b=c" });
  });

  it.each([
    { argv: ["-c", "maxIterations=42"], expected: { path: ["maxIterations"], value: 42 } },
    { argv: ["-c", "ollamaPort=11434"], expected: { path: ["ollamaPort"], value: 11434 } },
    { argv: ["-c", "search=true"], expected: { path: ["search"], value: true } },
    { argv: ["-c", "hideAbsolutePath=false"], expected: { path: ["hideAbsolutePath"], value: false } },
    { argv: ["-c", 'allowedTools=["read_file"]'], expected: { path: ["allowedTools"], value: ["read_file"] } },
    { argv: ["-c", 'hooks={"afterEdit":"npm test"}'], expected: { path: ["hooks"], value: { afterEdit: "npm test" } } },
    { argv: ["-c", 'statusBar=[{"id":"hint","enabled":false}]'], expected: { path: ["statusBar"], value: [{ id: "hint", enabled: false }] } },
    { argv: ["-c", "openaiApi=chat"], expected: { path: ["openaiApi"], value: "chat" } },
    { argv: ["-c", "provider=deepseek"], expected: { path: ["provider"], value: "deepseek" } },
    { argv: ["-c", "permissionMode=deny-writes"], expected: { path: ["permissionMode"], value: "deny-writes" } },
  ])("coerces $argv", ({ argv, expected }) => {
    expect(overridesWith(argv)).toEqual([expected]);
  });

  it.each(["1", "42", "0002", "9007199254740991"])("accepts maxIterations=%j via the shared --max-turns check", (value) => {
    expect(overridesWith(["-c", `maxIterations=${value}`]))
      .toEqual([{ path: ["maxIterations"], value: Number(value) }]);
  });

  it.each(["0", "-5", "1.5", "1e3", "10abc", "+2", "", "9007199254740992"])(
    "rejects maxIterations=%j exactly like --max-turns does", (value) => {
      expect(() => parseArgs(["-c", `maxIterations=${value}`])).toThrow(exitError);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("-c maxIterations must be a positive safe integer"));
      // Both flags share parseMaxTurns, so they must agree on valid input.
      expect(() => parseArgs(["--max-turns", value])).toThrow(exitError);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("--max-turns must be a positive safe integer"));
    },
  );

  it("parses dotted paths and coerces obvious scalars under them", () => {
    expect(parseConfigOverride("theme.promptColor=blue"))
      .toEqual({ path: ["theme", "promptColor"], value: "blue" });
  });

  it.each(["maxTokens.foo=1", "effort.low=1", "provider.name=x"])(
    "rejects traversal beneath scalar key %s", (entry) => {
      expect(() => parseArgs(["-c", entry])).toThrow(exitError);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("set it whole"));
    },
  );

  it.each(["allowedTools.foo=read_file", "statusBar.segments.0.n=3"])(
    "rejects a non-index segment beneath array key %s", (entry) => {
      expect(() => parseArgs(["-c", entry])).toThrow(exitError);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("by index"));
    },
  );

  it("accepts indexed edits beneath an array key", () => {
    expect(parseConfigOverride("allowedTools.0=read_file"))
      .toEqual({ path: ["allowedTools", "0"], value: "read_file" });
    expect(parseConfigOverride("statusBar.0.enabled=false"))
      .toEqual({ path: ["statusBar", "0", "enabled"], value: false });
  });

  it.each([
    ["-c", "a malformed entry with no equals sign"],
    ["-c", "foo"],
    ["-c", "=bar"],
    ["-c", "theme..x=1"],
    ["-c", ".x=1"],
    ["-c", "modl=x"],
    ["-c", "effort=ultra"],
    ["-c", "provider=mars"],
    ["-c", "maxIterations=abc"],
    ["-c", "maxIterations=-5"],
    ["-c", "maxIterations=1.5"],
    ["-c", "search=maybe"],
    ["-c", "allowedTools=oops"],
    ["-c", "openaiApi=bogus"],
    ["-c", "statusBar={}"],
    ["-c", "orgManagedProvider=ollama"],
    ["-c", "orgPermissionFloor=auto-accept"],
    ["-c", "openaiGatewayAuth=true"],
  ])("rejects %j with an actionable error", (...argv) => {
    expect(() => parseArgs(argv)).toThrow(exitError);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Error:"));
  });

  it.each(["orgAllowedModels", "orgAllowedProviders", "orgManagedProvider", "orgManagedModel", "orgPermissionFloor", "openaiGatewayAuth"])(
    "rejects org-managed key %s with a policy message instead of a suggestion",
    (key) => {
      expect(() => parseConfigOverride(`${key}=anything`)).toThrow(exitError);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("managed by organization policy"));
    },
  );

  it("accepts controlPlane, the same source tier as --control-plane", () => {
    expect(parseConfigOverride("controlPlane=https://cp.example")).toEqual({
      path: ["controlPlane"],
      value: "https://cp.example",
    });
  });

  it.each([
    ["login", "-c", "controlPlane=https://cp.example"],
    ["-c", "controlPlane=https://cp.example", "login"],
    ["logout", "-c", "controlPlane=https://cp.example"],
    ["job", "-c", "backgroundAutomation=paused"],
    ["-c", "backgroundAutomation=paused", "job"],
    ["mcp", "-c", "effort=low"],
    ["-c", "effort=low", "mcp"],
    ["-c", "workflowsEnabled=true", "workflows"],
    ["-c", "effort=low", "workflows", "run", "demo"],
  ])("rejects -c with %s, which resolves config before any session overlay exists", (...argv) => {
    expect(() => parseArgs(argv)).toThrow(exitError);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("not supported with"));
  });

  it("points login's rejection at --control-plane", () => {
    expect(() => parseArgs(["login", "-c", "controlPlane=https://cp.example"])).toThrow(exitError);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("--control-plane <url>"));
  });

  it("suggests the closest key for a typo", () => {
    expect(() => parseArgs(["-c", "efrot=low"])).toThrow(exitError);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('did you mean "effort"'));
  });

  it.each(["theme.__proto__.reviewMarker=true", "__proto__.evil=1", "theme.constructor.x=1", "x.prototype.y=1"])(
    "rejects prototype-polluting path %s at parse time",
    (entry) => {
      expect(() => parseArgs(["-c", entry])).toThrow(exitError);
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("prototype property"));
    },
  );

  it("leaves Object.prototype untouched after a rejected __proto__ path", () => {
    expect(() => parseArgs(["-c", "theme.__proto__.reviewMarker=true"])).toThrow(exitError);
    expect(Object.prototype).not.toHaveProperty("reviewMarker");
    expect(({} as Record<string, unknown>).reviewMarker).toBeUndefined();
  });

  it.each(["toString", "valueOf", "hasOwnProperty"])(
    "rejects inherited Object.prototype name %s as an unknown key",
    (key) => {
      expect(() => parseArgs(["-c", `${key}=x`])).toThrow(exitError);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("unknown config key"));
    },
  );

  it("rejects a missing value at the end of argv", () => {
    expect(() => parseArgs(["-P", "hi", "-c"])).toThrow(exitError);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("-c/--config expects key=value"));
  });
});

describe("applyConfigOverrides", () => {
  it("refuses a hand-crafted __proto__ path without polluting Object.prototype", () => {
    const target = { theme: { promptColor: "cyan" } } as unknown as AgavConfig;
    expect(() => applyConfigOverrides(target, [{ path: ["theme", "__proto__", "reviewMarker"], value: true }])).toThrow(exitError);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(({} as Record<string, unknown>).reviewMarker).toBeUndefined();
    expect(target.theme).toEqual({ promptColor: "cyan" });
  });

  it("refuses a hand-crafted constructor path", () => {
    expect(() => applyConfigOverrides({} as AgavConfig, [{ path: ["constructor"], value: "x" }])).toThrow(exitError);
  });

  it("sets one nested property without touching its siblings", () => {
    const target = { theme: { userLabel: "cyan" } } as unknown as AgavConfig;
    applyConfigOverrides(target, [{ path: ["theme", "promptColor"], value: "blue" }]);
    expect(target.theme).toEqual({ userLabel: "cyan", promptColor: "blue" });
  });

  it("creates missing intermediate objects", () => {
    const target = { effort: "medium" } as unknown as AgavConfig;
    applyConfigOverrides(target, [{ path: ["openaiHeaders", "x-api-key"], value: "tok" }]);
    expect((target as unknown as Record<string, unknown>)["openaiHeaders"]).toEqual({ "x-api-key": "tok" });
  });

  it("replaces an object leaf entirely when named without a dotted path", () => {
    const target = { theme: { userLabel: "cyan" } } as unknown as AgavConfig;
    applyConfigOverrides(target, [{ path: ["theme"], value: { promptColor: "blue" } }]);
    expect(target.theme).toEqual({ promptColor: "blue" });
  });

  it("replaces a whole array when named without a dotted path", () => {
    const target = { statusBar: [{ id: "model", enabled: true }] } as unknown as AgavConfig;
    applyConfigOverrides(target, [{ path: ["statusBar"], value: [{ id: "hint", enabled: false }] }]);
    expect(target.statusBar).toEqual([{ id: "hint", enabled: false }]);
  });

  it("preserves an existing array during an indexed edit", () => {
    const target = {
      statusBar: [{ id: "model", enabled: true }, { id: "hint", enabled: true }],
    } as unknown as AgavConfig;
    applyConfigOverrides(target, [{ path: ["statusBar", "1", "enabled"], value: false }]);
    expect(Array.isArray(target.statusBar)).toBe(true);
    expect(target.statusBar).toEqual([{ id: "model", enabled: true }, { id: "hint", enabled: false }]);
  });

  it("creates a missing intermediate as an array when the next segment is an index", () => {
    const target = {} as AgavConfig;
    applyConfigOverrides(target, [{ path: ["statusBar", "0", "enabled"], value: false }]);
    expect(target.statusBar).toEqual([{ enabled: false }]);
    expect(Array.isArray(target.statusBar)).toBe(true);
  });

  it("refuses a non-index segment under an existing array instead of destroying it", () => {
    const target = { statusBar: [{ id: "model", enabled: true }] } as unknown as AgavConfig;
    expect(() => applyConfigOverrides(target, [{ path: ["statusBar", "segments", "0", "n"], value: 3 }])).toThrow(exitError);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("must use a numeric index"));
    expect(target.statusBar).toEqual([{ id: "model", enabled: true }]);
  });
});

describe("-c/--config production CLI behavior", () => {
  it.each([["-P"], ["run"]])("%s applies overrides on top of the loaded config", async (command) => {
    process.argv = [process.execPath, "agav", command, "hello", "-c", "effort=low", "-c", "maxIterations=50"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "low", maxIterations: 50 }));
  });

  it("keeps the config-file value when no override is given", async () => {
    process.argv = [process.execPath, "agav", "-P", "hello"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "medium", maxIterations: 37 }));
  });

  it("lets dedicated flags win over -c on conflict", async () => {
    process.argv = [process.execPath, "agav", "-P", "hello", "-c", "effort=low", "-c", "maxIterations=50", "--effort", "high", "--max-turns", "10"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "high", maxIterations: 10 }));
  });

  it("pins provider and model against the last-session restore", async () => {
    vi.mocked(listSessions).mockResolvedValue([{ provider: "anthropic", model: "session-model" }] as never);
    process.argv = [process.execPath, "agav", "-P", "hello", "-c", "provider=ollama", "-c", "model=llama3.2"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "ollama", model: "llama3.2" }));
  });

  // Ollama has no static default (defaultModelForProvider → ""): main probes the
  // local server. Stubbing that probe doubles as proof the stale model was reset —
  // a kept claude model means no probe runs and this assertion fails.
  function stubOllamaProbe() {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [{ name: "llama3.2" }] }),
    })));
  }

  it("-c provider alone drops the old provider's model and re-picks, like --provider", async () => {
    stubOllamaProbe();
    process.argv = [process.execPath, "agav", "-P", "hello", "-c", "provider=ollama"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "ollama",
      model: "llama3.2",
    }));
  });

  it("-c provider replaces a resumed session's model from another provider", async () => {
    stubOllamaProbe();
    vi.mocked(listSessions).mockResolvedValue([{ id: "s1", provider: "anthropic", model: "session-claude" }] as never);
    vi.mocked(loadSession).mockResolvedValue({ id: "s1", messages: [], provider: "anthropic", model: "session-claude" } as never);
    process.argv = [process.execPath, "agav", "-P", "hello", "--resume", "s1", "-c", "provider=ollama"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "ollama",
      model: "llama3.2",
    }));
  });

  it("control: without -c the last-session restore still adopts its model", async () => {
    vi.mocked(listSessions).mockResolvedValue([{ provider: "anthropic", model: "session-model" }] as never);
    process.argv = [process.execPath, "agav", "-P", "hello"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "anthropic", model: "session-model" }));
  });

  it("expands a ~ path carried by -c before the provider sees it", async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    process.argv = [process.execPath, "agav", "-P", "hello", "-c", "provider=vertex-ai", "-c", "vertexAICredentialsPath=~/.gcp/sa.json"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      vertexAICredentialsPath: join(homedir(), ".gcp/sa.json"),
    }));
  });

  it("fails at parse time, before loadConfig, on a malformed entry", async () => {
    process.argv = [process.execPath, "agav", "-P", "hello", "-c", "foo"];
    await expect(main()).rejects.toThrow(exitError);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("prints a session-overrides notice in interactive mode", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      // No API keys: startup fails right after the notice, before Ink would render.
      delete config.anthropicApiKey;
      process.argv = [process.execPath, "agav", "-c", "effort=low"];
      await expect(main()).rejects.toThrow(exitError);
      const written = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0])).join("");
      expect(written).toContain("session overrides: effort");
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("re-asserts organization policy after applying -c overrides", async () => {
    vi.mocked(loadOrgPolicy).mockResolvedValue({
      config: { provider: "openai", openaiBaseURL: "https://gateway.corp.example/v1", permissionMode: "ask" },
    });
    config.openaiApiKey = "test-key";
    process.argv = [process.execPath, "agav", "-P", "hello",
      "-c", "provider=ollama", "-c", "openaiBaseURL=https://evil.example", "-c", "permissionMode=auto-accept"];
    await expect(main()).rejects.toThrow(providerReached);
    // Hard pin, gateway URL, and permission floor all outrank the -c layer.
    expect(config.provider).toBe("openai");
    expect(config.openaiBaseURL).toBe("https://gateway.corp.example/v1");
    expect(config.permissionMode).toBe("ask");
    expect(config.orgManagedProvider).toBe("openai");
    expect(config.orgPermissionFloor).toBe("ask");
  });
});
