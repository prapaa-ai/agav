import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import { listSessions } from "../config/history.js";
import {
  noProviderCredentialsError,
  orgPolicyError,
  providerConfigurationError,
  resolveStartupSelection,
  selectConfiguredProvider,
} from "../config/startup.js";
import { applyOrgConfig } from "../config/org-config.js";
import { parseArgs } from "../main.js";

const base: AgavConfig = {
  provider: "anthropic",
  model: "configured-claude",
  effort: "high",
  maxTokens: 1024,
  maxIterations: 10,
  errorRetries: 1,
  permissionMode: "ask",
};

vi.mock("../config/history.js", () => ({
  listSessions: vi.fn(),
}));

describe("parseArgs", () => {
  it("parses --cwd with space separation", () => {
    const flags = parseArgs(["--cwd", "/fake/path"]);
    expect(flags.cwd).toBe("/fake/path");
  });

  it("parses --cwd= with equals separation", () => {
    const flags = parseArgs(["--cwd=/fake/path"]);
    expect(flags.cwd).toBe("/fake/path");
  });

  it("leaves flags.cwd undefined if --cwd is omitted", () => {
    const flags = parseArgs(["--help"]);
    expect(flags.cwd).toBeUndefined();
  });

  it("parses --name with space separation", () => {
    const flags = parseArgs(["--name", "My run"]);
    expect(flags.name).toBe("My run");
  });

  it("parses --name= with equals separation", () => {
    const flags = parseArgs(["--name=My run"]);
    expect(flags.name).toBe("My run");
  });

  it("preserves embedded equals signs in --name= value", () => {
    const flags = parseArgs(["--name=a=b"]);
    expect(flags.name).toBe("a=b");
  });

  it("leaves flags.name undefined if --name is omitted", () => {
    const flags = parseArgs(["--help"]);
    expect(flags.name).toBeUndefined();
  });

  it("parses empty and whitespace-only --name values", () => {
    expect(parseArgs(["--name="]).name).toBe("");
    expect(parseArgs(["--name", ""]).name).toBe("");
    expect(parseArgs(["--name", "   "]).name).toBe("   ");
    expect(parseArgs(["--name=   "]).name).toBe("   ");
  });

  it("handles missing flag value at end of argv for --name consistently with neighboring string flags", () => {
    const flags = parseArgs(["--name"]);
    expect(flags.name).toBe("");
  });

  it("rejects --name combined with --print or -P", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const mockStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    parseArgs(["--print", "prompt", "--name", "My run"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    parseArgs(["-P", "prompt", "--name=My run"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    parseArgs(["--name", "My run", "-P", "prompt"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    // When --name has a missing value preceding --print or -P
    parseArgs(["--name", "--print", "prompt"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    parseArgs(["--name", "-P", "prompt"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    // Even when name is empty or whitespace
    parseArgs(["-P", "prompt", "--name="]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockRestore();
    mockStderr.mockRestore();
  });

  it("does not consume another option flag as the --name value when value is missing", () => {
    const flags = parseArgs(["--name", "--model", "gpt-4o"]);
    expect(flags.name).toBe("");
    expect(flags.model).toBe("gpt-4o");
  });

  it("rejects --name combined with run", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const mockStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    parseArgs(["run", "prompt", "--name", "My run"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    parseArgs(["run", "--name=My run", "prompt"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    parseArgs(["--name", "My run", "run", "prompt"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    // Even when missing value at end or whitespace
    parseArgs(["run", "prompt", "--name"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockClear();
    mockStderr.mockClear();

    parseArgs(["run", "--name=   ", "prompt"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--name is only supported for interactive sessions"));

    mockExit.mockRestore();
    mockStderr.mockRestore();
  });

  it("permits ordinary --print and run invocations without --name", () => {
    const printFlags = parseArgs(["--print", "prompt"]);
    expect(printFlags.print).toBe(true);
    expect(printFlags.printPrompt).toBe("prompt");
    expect(printFlags.name).toBeUndefined();

    const shortPrintFlags = parseArgs(["-P", "prompt"]);
    expect(shortPrintFlags.print).toBe(true);
    expect(shortPrintFlags.printPrompt).toBe("prompt");
    expect(shortPrintFlags.name).toBeUndefined();

    const runFlags = parseArgs(["run", "prompt"]);
    expect(runFlags.run).toBe(true);
    expect(runFlags.runPrompt).toBe("prompt");
    expect(runFlags.name).toBeUndefined();
  });

  it("recognizes subcommands even when flags precede them", () => {
    const runFlags = parseArgs(["--cwd", "/repo", "run"]);
    expect(runFlags.run).toBe(true);

    const agentFlags = parseArgs(["--cwd=/repo", "agents"]);
    expect(agentFlags.agents).toBe(true);

    const updateFlags = parseArgs(["--cwd", "/repo", "update"]);
    expect(updateFlags.update).toBe(true);

    const sessionFlags = parseArgs(["--cwd", "/repo", "sessions"]);
    expect(sessionFlags.sessions).toBe(true);
  });

  it("treats missing or empty --cwd values as process exits", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const mockStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    
    parseArgs(["--cwd"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--cwd requires a directory argument"));
    
    mockExit.mockClear();
    parseArgs(["--cwd="]);
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    mockStderr.mockRestore();
  });

  it("does not consume another option flag as the --cwd argument", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const mockStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    
    parseArgs(["--cwd", "--help"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--cwd requires a directory argument"));

    mockExit.mockRestore();
    mockStderr.mockRestore();
  });

  it("collects positionals accurately even when global flags are interspersed", () => {
    const flags = parseArgs(["skills", "--cwd", "/repo", "remove", "target"]);
    expect(flags.skills).toBe(true);
    expect(flags.skillsCommand).toBe("remove");
    expect(flags._).toEqual(["remove", "target"]);
  });

  it("safely ignores global flags masquerading as subcommand arguments", () => {
    // Tests: agav --cwd skills skills remove target
    const flags = parseArgs(["--cwd", "skills", "skills", "remove", "target"]);
    expect(flags.cwd).toBe("skills");
    expect(flags.skills).toBe(true);
    expect(flags.skillsCommand).toBe("remove");
    expect(flags._).toEqual(["remove", "target"]);
  });

  it("safely passes unknown flags to the leftover array if a subcommand is active", () => {
    const flags = parseArgs(["agents", "--alias", "foo", "install", "url"]);
    expect(flags.agents).toBe(true);
    expect(flags._).toEqual(["--alias", "foo", "install", "url"]);
    expect(flags.agentsCommand).toBe("--alias"); // The action verb is unfortunately seen as the flag, working as intended for POSIX.
  });

  it("stops flag parsing completely after the -- separator", () => {
    const flags = parseArgs(["skills", "remove", "--", "--version"]);
    expect(flags.skills).toBe(true);
    expect(flags.version).toBeUndefined(); // It did NOT trigger global --version!
    expect(flags._).toEqual(["remove", "--version"]); // The subcommand receives --version safely.
  });

  it("joins multiple positionals for run and print, allowing unquoted usage", () => {
    const flags = parseArgs(["run", "explain", "this", "file"]);
    expect(flags.run).toBe(true);
    expect(flags.runPrompt).toBe("explain this file");

    const flags2 = parseArgs(["--print", "hello", "world"]);
    expect(flags2.print).toBe(true);
    expect(flags2.printPrompt).toBe("hello world");
  });

  describe.each(["run", "--print", "-P"])("%s option separator", (command) => {
    it.each([
      { tokens: ["explain", "--", "version"], prompt: "explain -- version" },
      { tokens: ["--", "explain", "--", "--", "version", "--"], prompt: "-- explain -- -- version --" },
      { tokens: ["explain", "--"], prompt: "explain --" },
      { tokens: ["--"], prompt: "--" },
      { tokens: ["--version", "--help", "--cwd", "--model=literal", "--unknown", "-y"], prompt: "--version --help --cwd --model=literal --unknown -y" },
      { tokens: ["run", "update", "agents", "skills", "--print"], prompt: "run update agents skills --print" },
    ])("preserves literal prompt: $prompt", ({ tokens, prompt }) => {
      const flags = parseArgs([command, "--", ...tokens]);
      expect(flags).toEqual(command === "run"
        ? { _: tokens, run: true, runPrompt: prompt }
        : { _: tokens, print: true, printPrompt: prompt });
    });

    it("consumes the initial separator without adding prompt content", () => {
      const flags = parseArgs([command, "--"]);
      expect(flags).toEqual(command === "run" ? { _: [], run: true } : { _: [], print: true });
    });

    it("still parses normal options before the separator", () => {
      const flags = parseArgs(["--cwd", "/repo", command, "--model=selected", "--stream", "--", "explain", "--version"]);
      expect(flags).toEqual({
        _: ["explain", "--version"],
        cwd: "/repo",
        model: "selected",
        stream: true,
        ...(command === "run"
          ? { run: true, runPrompt: "explain --version" }
          : { print: true, printPrompt: "explain --version" }),
      });
    });
  });

  it("rejects extra positionals for update", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const mockStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    
    parseArgs(["update", "0.2.4", "extra"]);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("agav update accepts at most 1 argument"));

    mockExit.mockRestore();
    mockStderr.mockRestore();
  });

  it("rejects leftover positionals if no command accepts them", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const mockStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    
    parseArgs(["hello"]); // "hello" is unhandled
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("unexpected arguments: hello"));

    mockExit.mockRestore();
    mockStderr.mockRestore();
  });
});

describe("subcommand strict argument parsing", () => {
  it("rejects unknown flags for skills clear", async () => {
    const { runSkillsCommand } = await import("../cli/skills-cli.js");
    const mockStderr = vi.spyOn(console, "error").mockImplementation(() => true);
    
    const code = await runSkillsCommand("clear", ["--bogus"]);
    expect(code).toBe(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("Unknown option '--bogus'"));
    
    mockStderr.mockRestore();
  });

  it("rejects misspelled options for agents remove", async () => {
    const { runAgentsCommand } = await import("../cli/agents-cli.js");
    const mockStderr = vi.spyOn(console, "error").mockImplementation(() => true);
    
    const code = await runAgentsCommand("remove", ["target", "--destinatoin", "project"]);
    expect(code).toBe(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("Unknown option '--destinatoin'"));
    
    mockStderr.mockRestore();
  });

  it("rejects missing values for valid agent options", async () => {
    const { runAgentsCommand } = await import("../cli/agents-cli.js");
    const mockStderr = vi.spyOn(console, "error").mockImplementation(() => true);
    
    const code = await runAgentsCommand("remove", ["target", "--destination"]);
    expect(code).toBe(1);
    expect(mockStderr).toHaveBeenCalledWith(expect.stringContaining("--destination must be 'global' or 'project'"));
    
    mockStderr.mockRestore();
  });

  it("joins unquoted paths for skill installation", async () => {
    // This isn't an error case, we just want to ensure it joins spaces correctly without crashing
    const { runSkillsCommand } = await import("../cli/skills-cli.js");
    const mockStderr = vi.spyOn(console, "error").mockImplementation(() => true);
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => true);
    
    // We expect it to try installing from "C:/My Skills/Tool" and fail gracefully 
    // at the file-system level, NOT at the argument-parsing level.
    const code = await runSkillsCommand("add", ["C:/My", "Skills/Tool"]);
    // The installer should log the joined path
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("C:/My Skills/Tool"));
    
    mockStderr.mockRestore();
    mockLog.mockRestore();
  });
});

describe("startup provider and model resolution", () => {
  it("keeps configured selection for plain startup", async () => {
    expect(await resolveStartupSelection(base, {})).toMatchObject({
      provider: "anthropic",
      model: "configured-claude",
    });
  });

  it("uses the selected provider default when --provider changes provider", async () => {
    expect(await resolveStartupSelection(base, { cliProvider: "openai" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(await resolveStartupSelection(base, { cliProvider: "openrouter" })).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
    });
  });

  it("restores both provider and model from a resumed session", async () => {
    expect(await resolveStartupSelection(base, {
      session: { provider: "gemini", model: "gemini-session-model" },
    })).toMatchObject({ provider: "gemini", model: "gemini-session-model" });
  });

  it("does not combine a CLI provider override with another provider's saved model", async () => {
    expect(await resolveStartupSelection(base, {
      cliProvider: "openai",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("retains the saved model when the CLI provider matches the session", async () => {
    expect(await resolveStartupSelection(base, {
      cliProvider: "anthropic",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "anthropic", model: "claude-session-model" });
  });

  it("keeps an explicit provider/model pair authoritative", async () => {
    expect(await resolveStartupSelection(base, {
      cliProvider: "openai",
      cliModel: "custom-openai-model",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "openai", model: "custom-openai-model" });
  });

  it("preserves an unqualified CLI model until catalog resolution selects its provider", async () => {
    expect(await resolveStartupSelection({ ...base, provider: "openai", model: "gpt-5.4-mini" }, {
      cliModel: "sonnet-5",
    })).toMatchObject({ provider: "openai", model: "sonnet-5" });
  });

  it("retains an unmatched CLI model when provider catalog lookup cannot resolve it", async () => {
    expect(await resolveStartupSelection({ ...base, provider: "openai", model: "gpt-5.4-mini" }, {
      cliModel: "private-model",
    })).toMatchObject({ provider: "openai", model: "private-model" });
  });


  it("rejects an unsupported saved provider unless the CLI replaces it", async () => {
    await expect(
      resolveStartupSelection(base, {
        session: { provider: "removed-provider", model: "old-model" },
      })
    ).rejects.toThrow("Saved session uses unsupported provider");

    expect(
      await resolveStartupSelection(base, {
        cliProvider: "gemini",
        session: { provider: "removed-provider", model: "old-model" },
      })
    ).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite" });
  });

  it("auto-selects an available provider only for an unpinned startup", () => {
    expect(selectConfiguredProvider({ ...base, openaiApiKey: "key" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(selectConfiguredProvider({ ...base, openrouterApiKey: "key" })).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
    });
  });

  it("keeps an explicit --model when falling back to another provider", () => {
    expect(selectConfiguredProvider({ ...base, model: "gpt-4o", openaiApiKey: "key" }, { keepModel: true }))
      .toMatchObject({ provider: "openai", model: "gpt-4o" });
  });

  it("enables Vertex AI from the credentials path alone", () => {
    const config: AgavConfig = { ...base, provider: "vertex-ai", model: "vertex/gemini-3.5-flash" };
    expect(providerConfigurationError(config)).toContain("VERTEX_AI_CREDENTIALS_PATH");
    expect(providerConfigurationError({ ...config, vertexAICredentialsPath: "/tmp/sa.json" })).toBeNull();
  });

  it("names a runnable command for every provider when nothing is configured", () => {
    const message = noProviderCredentialsError();
    for (const variable of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "VERTEX_AI_CREDENTIALS_PATH"]) {
      // The shell-specific prefix is covered by utils.shell-hints; here it only
      // matters that each variable is shown as a command, not just named.
      expect(message).toMatch(new RegExp(`(export|set|\\$env:)\\s?${variable}`));
    }
    expect(message).toContain("agav --provider ollama");
  });

  it("reports the selected provider's exact missing configuration", () => {
    expect(providerConfigurationError({ ...base, anthropicApiKey: undefined }))
      .toContain("ANTHROPIC_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openai", openaiApiKey: undefined }))
      .toContain("OPENAI_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openrouter", openrouterApiKey: undefined }))
      .toContain("OPENROUTER_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openrouter", openrouterApiKey: "sk-or-test" }))
      .toBeNull();
  });

  it("accepts enrollment gateway auth in place of a personal OpenAI key", () => {
    // A gateway-only enrolled developer has no openaiApiKey but authenticates via
    // the injected gateway token (openaiGatewayAuth); startup must not block them.
    expect(
      providerConfigurationError({
        ...base,
        provider: "openai",
        openaiApiKey: undefined,
        openaiGatewayAuth: true,
      }),
    ).toBeNull();
  });
});

describe("organization selection policy", () => {
  it("returns null when no org restriction is set", () => {
    expect(orgPolicyError({ ...base })).toBeNull();
  });

  it("returns null when an empty allowlist is present (no restriction)", () => {
    expect(orgPolicyError({ ...base, orgAllowedProviders: [], orgAllowedModels: [] })).toBeNull();
  });

  it("rejects a provider outside the org allowlist", () => {
    const err = orgPolicyError({ ...base, provider: "openai", orgAllowedProviders: ["anthropic"] });
    expect(err).toContain("not permitted by your organization");
    expect(err).toContain("openai");
  });

  it("permits a provider inside the org allowlist", () => {
    expect(orgPolicyError({ ...base, provider: "anthropic", orgAllowedProviders: ["anthropic", "openai"] }))
      .toBeNull();
  });

  it("rejects a model outside the org allowlist", () => {
    const err = orgPolicyError({ ...base, model: "forbidden-model", orgAllowedModels: ["configured-claude"] });
    expect(err).toContain("not permitted by your organization");
    expect(err).toContain("forbidden-model");
  });

  it("permits a model inside the org allowlist", () => {
    expect(orgPolicyError({ ...base, model: "configured-claude", orgAllowedModels: ["configured-claude"] }))
      .toBeNull();
  });

  it("surfaces the policy error through providerConfigurationError before a missing-key error", () => {
    // Out-of-policy provider AND missing key: policy violation must win.
    const err = providerConfigurationError({
      ...base,
      provider: "openai",
      openaiApiKey: undefined,
      orgAllowedProviders: ["anthropic"],
    });
    expect(err).toContain("not permitted by your organization");
    expect(err).not.toContain("OPENAI_API_KEY");
  });

  it("rejects a provider that drifted from a managed hard pin (not a singleton allowlist)", () => {
    // Policy pins openai; a later CLI/recent-session selection of ollama must be
    // caught even though there is no allowlist duplicating the pin.
    const err = orgPolicyError({ ...base, provider: "ollama", orgManagedProvider: "openai" });
    expect(err).toContain("not permitted by your organization");
    expect(err).toContain("requires provider");
  });

  it("rejects a model that drifted from a managed hard pin", () => {
    const err = orgPolicyError({ ...base, model: "external-model", orgManagedModel: "gpt-5.4" });
    expect(err).toContain("not permitted by your organization");
    expect(err).toContain("requires model");
  });

  it("permits a provider/model that still matches the managed pin", () => {
    expect(orgPolicyError({
      ...base,
      provider: "openai",
      model: "gpt-5.4",
      orgManagedProvider: "openai",
      orgManagedModel: "gpt-5.4",
    })).toBeNull();
  });
});

describe("listSessions and recent session startup resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to the most recent session's model and provider on plain startup", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "session-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        title: "Saved Session",
        messages: [],
      },
    ]);
    const selection = await resolveStartupSelection(base, {});
    expect(selection).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("prefers explicit CLI provider over saved session history", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "session-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        title: "Saved Session",
        messages: [],
      },
    ]);
    const selection = await resolveStartupSelection(base, { cliProvider: "anthropic" });
    expect(selection).toMatchObject({
      provider: "anthropic",
      model: "configured-claude",
    });
  });

  it("returns empty array if no history exists", async () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  it("keeps managed pins authoritative over an implicit recent-session default", async () => {
    // Last session used Anthropic, but the org pins openai/gpt-5.4 and the user
    // gave no explicit override: the pin must win so startup is not then rejected.
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "session-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        title: "Saved Session",
        messages: [],
      },
    ]);
    const pinned = { ...base, orgManagedProvider: "openai" as const, orgManagedModel: "gpt-5.4" };
    const selection = await resolveStartupSelection(pinned, {});
    expect(selection).toMatchObject({ provider: "openai", model: "gpt-5.4" });
  });

  it("does NOT silently correct an explicit out-of-policy CLI selection (left for policy rejection)", async () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    const pinned = { ...base, orgManagedProvider: "openai" as const, orgManagedModel: "gpt-5.4" };
    // An explicit --provider/--model stays as the user typed it so orgPolicyError
    // can reject it, rather than being quietly overridden by the pin.
    const selection = await resolveStartupSelection(pinned, { cliProvider: "ollama", cliModel: "llama3" });
    expect(selection).toMatchObject({ provider: "ollama", model: "llama3" });
    expect(orgPolicyError(selection)).toMatch(/not permitted by your organization/);
  });

  it("keeps a compatible pair for a provider-only pin when the recent session conflicts", async () => {
    // Configured openai/gpt-5.4-mini, pin provider=openai only, latest session is
    // Anthropic. The Anthropic model must NOT be paired with the openai pin.
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "s1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        title: "Saved",
        messages: [],
      },
    ]);
    const cfg = { ...base, provider: "openai" as const, model: "gpt-5.4-mini", orgManagedProvider: "openai" as const };
    const selection = await resolveStartupSelection(cfg, {});
    expect(selection).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("keeps a compatible pair for a model-only pin when the recent session conflicts", async () => {
    // Configured openai/gpt-5.4-mini, pin model=gpt-5.4-mini only, latest session
    // is Anthropic. The pinned model must NOT be paired with the Anthropic provider.
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "s1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        title: "Saved",
        messages: [],
      },
    ]);
    const cfg = { ...base, provider: "openai" as const, model: "gpt-5.4-mini", orgManagedModel: "gpt-5.4-mini" };
    const selection = await resolveStartupSelection(cfg, {});
    expect(selection).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("still uses recent-session history when it is compatible with a partial pin", async () => {
    // Pin provider=openai; the latest session is also openai, so its model is fine.
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "s1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        title: "Saved",
        messages: [],
      },
    ]);
    const cfg = { ...base, provider: "openai" as const, model: "gpt-5.4-mini", orgManagedProvider: "openai" as const };
    const selection = await resolveStartupSelection(cfg, {});
    expect(selection).toMatchObject({ provider: "openai", model: "gpt-4o" });
  });
});

describe("partial managed pins produce a compatible pair (applyOrgConfig -> resolveStartupSelection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSessions).mockResolvedValue([]);
  });

  const anthropicConfig = (): AgavConfig => ({ ...base, provider: "anthropic", model: "claude-sonnet-4-20250514" });
  const anthropicSession = {
    id: "s1",
    createdAt: "2025-01-01T00:00:00.000Z",
    provider: "anthropic" as const,
    model: "claude-sonnet-4-20250514",
    title: "Saved",
    messages: [],
  };

  it("applyOrgConfig alone resets the model to the provider default for a provider-only pin", () => {
    // Starting from an incompatible anthropic config, a provider-only openai pin
    // must not leave openai + claude-sonnet.
    const cfg = applyOrgConfig(anthropicConfig(), { provider: "openai" });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.4-mini"); // openai default, not claude-sonnet
  });

  it("provider-only pin, plain start with conflicting history → compatible pair", async () => {
    vi.mocked(listSessions).mockResolvedValue([anthropicSession]);
    const cfg = applyOrgConfig(anthropicConfig(), { provider: "openai" });
    const selection = await resolveStartupSelection(cfg, {});
    expect(selection.provider).toBe("openai");
    expect(selection.model).toBe("gpt-5.4-mini");
    expect(providerConfigurationError({ ...selection, openaiApiKey: "k" })).toBeNull();
  });

  it("provider-only pin, resuming a conflicting session → compatible pair", async () => {
    const cfg = applyOrgConfig(anthropicConfig(), { provider: "openai" });
    const selection = await resolveStartupSelection(cfg, { session: anthropicSession });
    expect(selection.provider).toBe("openai");
    // Not the resumed Anthropic model paired with the openai pin.
    expect(selection.model).toBe("gpt-5.4-mini");
  });

  it("model-only pin, resuming a conflicting session → compatible configured provider", async () => {
    // Configured openai/gpt-5.4-mini, model-only pin, resume Anthropic. Must keep
    // the configured openai provider with the pinned model, not anthropic.
    const cfg = applyOrgConfig(
      { ...base, provider: "openai", model: "gpt-5.4-mini" },
      { model: "gpt-5.4-mini" },
    );
    const selection = await resolveStartupSelection(cfg, { session: anthropicSession });
    expect(selection.provider).toBe("openai");
    expect(selection.model).toBe("gpt-5.4-mini");
  });

  it("model-only pin, plain start with conflicting history → compatible configured provider", async () => {
    vi.mocked(listSessions).mockResolvedValue([anthropicSession]);
    const cfg = applyOrgConfig(
      { ...base, provider: "openai", model: "gpt-5.4-mini" },
      { model: "gpt-5.4-mini" },
    );
    const selection = await resolveStartupSelection(cfg, {});
    expect(selection.provider).toBe("openai");
    expect(selection.model).toBe("gpt-5.4-mini");
  });
});
