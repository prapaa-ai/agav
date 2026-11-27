import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../main.js";

describe("CLI argument parsing", () => {
  it("parses --search flag as true", () => {
    const flags = parseArgs(["--search"]);
    expect(flags.search).toBe(true);
  });

  it("leaves search undefined when --search is not supplied", () => {
    const flags = parseArgs(["--model", "gpt-4o"]);
    expect(flags.search).toBeUndefined();
    expect(flags.model).toBe("gpt-4o");
  });

  it("parses --search alongside other flags and commands", () => {
    const flags = parseArgs(["--search", "--provider", "openai", "--effort", "high"]);
    expect(flags.search).toBe(true);
    expect(flags.provider).toBe("openai");
    expect(flags.effort).toBe("high");
  });

  it("parses --search in print mode", () => {
    const flags = parseArgs(["-P", "--search", "explain this"]);
    expect(flags.print).toBe(true);
    expect(flags.search).toBe(true);
    expect(flags.printPrompt).toBe("explain this");
  });

  it("handles --search at different argument positions", () => {
    const flags = parseArgs(["--provider", "anthropic", "--search", "--model", "claude-sonnet-4-20250514"]);
    expect(flags.search).toBe(true);
    expect(flags.provider).toBe("anthropic");
    expect(flags.model).toBe("claude-sonnet-4-20250514");
  });

  it("parses --effort minimal and --effort=minimal", () => {
    const flags1 = parseArgs(["--effort", "minimal"]);
    expect(flags1.effort).toBe("minimal");

    const flags2 = parseArgs(["--effort=minimal"]);
    expect(flags2.effort).toBe("minimal");
  });

  it.each([
    { option: "--provider", field: "provider", value: "ollama=extra" },
    { option: "--model", field: "model", value: "=model=variant" },
    { option: "--ollama-host", field: "ollamaHost", value: "ollama=example" },
    { option: "--ollama-port", field: "ollamaPort", value: "11434=extra" },
    { option: "--ollama-endpoint", field: "ollamaEndpoint", value: "/api/chat?tag=a=b" },
  ])("preserves equals signs in $option values", ({ option, field, value }) => {
    expect(parseArgs([option, value])[field]).toBe(value);
    expect(parseArgs([`${option}=${value}`])[field]).toBe(value);
  });

  it("preserves trailing equals signs in Ollama API keys", () => {
    const dummyKey = "placeholder==";
    const separate = parseArgs(["--ollama-api-key", dummyKey]);
    const inline = parseArgs([`--ollama-api-key=${dummyKey}`]);
    expect(separate.ollamaApiKey === dummyKey).toBe(true);
    expect(inline.ollamaApiKey === dummyKey).toBe(true);
  });

  it("recognizes the login subcommand and passes its flags through", () => {
    const flags = parseArgs(["login", "--device", "--issuer", "https://idp", "--client-id", "cli"]);
    expect(flags.login).toBe(true);
    // The "login" token is consumed by the subcommand branch; its own flags are
    // collected as positional args rather than rejected as unknown flags.
    expect(flags._).toEqual(["--device", "--issuer", "https://idp", "--client-id", "cli"]);
  });

  it("recognizes the logout subcommand", () => {
    const flags = parseArgs(["logout"]);
    expect(flags.logout).toBe(true);
  });

  it("recognizes login after a -- separator (e.g. pnpm start -- login)", () => {
    const flags = parseArgs(["--", "login", "--oidc"]);
    expect(flags.login).toBe(true);
    // The login token is consumed; its own flags remain as positionals.
    expect(flags._).toEqual(["--oidc"]);
  });

  it("recognizes logout after a -- separator", () => {
    const flags = parseArgs(["--", "logout"]);
    expect(flags.logout).toBe(true);
    expect(flags._).toEqual([]);
  });

  it("does not mistake 'mcp logout <name>' for the enterprise logout subcommand", () => {
    const flags = parseArgs(["mcp", "logout", "figma"]);
    expect(flags.mcp).toBe(true);
    expect(flags.mcpCommand).toBe("logout");
    expect(flags.logout).toBeUndefined();          // not hijacked
    expect(flags._).toEqual(["logout", "figma"]);  // positionals stay intact
  });

  it("does not mistake 'mcp login <name>' for the enterprise login subcommand", () => {
    const flags = parseArgs(["mcp", "login", "figma"]);
    expect(flags.mcp).toBe(true);
    expect(flags.login).toBeUndefined();
  });

  it.each([
    { argv: ["--model"], expected: "--model" },
    { argv: ["-m"], expected: "-m" },
    { argv: ["--model", "--version"], expected: "--model" },
    { argv: ["--model", "--"], expected: "--model" },
    { argv: ["--model="], expected: "--model" },
    { argv: ["--provider"], expected: "--provider" },
    { argv: ["-p"], expected: "-p" },
    { argv: ["--provider", "--help"], expected: "--provider" },
    { argv: ["--provider", "--"], expected: "--provider" },
    { argv: ["--provider="], expected: "--provider" },
  ])("exits nonzero with an option-specific error for $argv", ({ argv, expected }) => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    try {
      expect(() => parseArgs(argv)).toThrow("EXIT:1");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain(expected);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
