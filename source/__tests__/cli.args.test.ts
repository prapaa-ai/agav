import { describe, expect, it } from "vitest";
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
});
