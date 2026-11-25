import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commands/registry.js";
import { createHelpCommand } from "../commands/help.js";
import { MID_TURN_SAFE_COMMANDS } from "../commands/mid-turn.js";
import type { CommandContext, SlashCommand } from "../commands/types.js";

const context = {} as CommandContext;

const commands: SlashCommand[] = [...MID_TURN_SAFE_COMMANDS].map((name) => ({
  name,
  description: `${name} command`,
  async execute() {
    return { type: "message", text: name };
  },
}));

describe("commands/help", () => {
  it("lists every registered built-in exactly once outside dynamic command sections", async () => {
    const registry = new CommandRegistry();
    const result = await registry.execute("/help", context);
    if (result?.type !== "message") throw new Error("expected message result");

    const listing = result.text.split("  While Agav is working:")[0]!;
    const names = [...listing.matchAll(/^    \/(\S+)\s/gm)].map(match => match[1]);
    expect(names.sort()).toEqual([...registry.list().map(command => command.name), "ps"].sort());
    expect(listing).not.toContain("  Skill commands\n");
    expect(listing).not.toContain("  Agent commands\n");
  });

  it("lists commands that can run while Agav is working", async () => {
    const helpCommand = createHelpCommand(() => commands);

    const result = await helpCommand.execute("", context);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected message result");
    expect(result.text).toContain("While Agav is working:");
    for (const name of MID_TURN_SAFE_COMMANDS) {
      expect(result.text).toContain(`/${name}`);
    }
  });

  it("resolves queries with leading and trailing whitespace and leading slashes", async () => {
    const customCommand: SlashCommand = {
      name: "custom",
      description: "Custom command description",
      execute: vi.fn(),
    };
    const helpCommand = createHelpCommand(() => [customCommand]);

    const queries = ["  custom", "custom  ", "  custom  ", "/custom", "  /custom  "];
    for (const query of queries) {
      const result = await helpCommand.execute(query, context);
      expect(result).toEqual({
        type: "message",
        text: "/custom — Custom command description",
      });
    }
  });

  it("formats detailed help for a command with usage", async () => {
    const commandWithUsage: SlashCommand = {
      name: "model",
      description: "Switch active LLM model",
      usage: "Usage: /model <name>\n\nExamples:\n  /model gpt-5\n  /model claude-3-7-sonnet",
      execute: vi.fn(),
    };
    const helpCommand = createHelpCommand(() => [commandWithUsage]);

    const result = await helpCommand.execute("model", context);

    expect(result).toEqual({
      type: "message",
      text: "/model — Switch active LLM model\n\nUsage: /model <name>\n\nExamples:\n  /model gpt-5\n  /model claude-3-7-sonnet",
    });
  });

  it("formats detailed help for a command without usage", async () => {
    const commandWithoutUsage: SlashCommand = {
      name: "clear",
      description: "Clear conversation history",
      execute: vi.fn(),
    };
    const helpCommand = createHelpCommand(() => [commandWithoutUsage]);

    const result = await helpCommand.execute("clear", context);

    expect(result).toEqual({
      type: "message",
      text: "/clear — Clear conversation history",
    });
  });

  it("returns an unknown command message when query is not found", async () => {
    const helpCommand = createHelpCommand(() => []);

    const result = await helpCommand.execute("unknown", context);
    expect(result).toEqual({
      type: "message",
      text: "Unknown command: /unknown",
    });

    const paddedResult = await helpCommand.execute("  /unknown  ", context);
    expect(paddedResult).toEqual({
      type: "message",
      text: "Unknown command: /unknown",
    });
  });

  it("resolves virtual ps command when absent from the supplied registry", async () => {
    const helpCommand = createHelpCommand(() => []);

    const result = await helpCommand.execute("  /ps  ", context);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected message result");
    expect(result.text).toContain("/ps — Run a side query while the agent is working");
    expect(result.text).toContain("Usage: /ps <question>");
    expect(result.text).toContain("Runs an independent query that doesn't interrupt the active agent turn.");
  });

  it("never executes the target command when displaying help", async () => {
    const executeSpy = vi.fn<SlashCommand["execute"]>();
    const targetCommand: SlashCommand = {
      name: "deploy",
      description: "Deploy the active workspace",
      usage: "Usage: /deploy <environment>",
      execute: executeSpy,
    };
    const helpCommand = createHelpCommand(() => [targetCommand]);

    const result = await helpCommand.execute("deploy", context);

    expect(result).toEqual({
      type: "message",
      text: "/deploy — Deploy the active workspace\n\nUsage: /deploy <environment>",
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe("commands/help search", () => {
  it("accepts slash-prefixed command names and formats agent descriptions like the listing", async () => {
    const registry = new CommandRegistry();
    const execute = vi.fn<SlashCommand["execute"]>();
    registry.register({ name: "agent-example", description: "[agent] Find /path entries", execute });
    expect(await registry.execute("/help --search /agent-example", context)).toMatchObject({ text: "/agent-example — Find /path entries" });
    expect(await registry.execute("/help --search /path", context)).toMatchObject({ text: "/agent-example — Find /path entries" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("lists search in the help tip and detailed help usage", async () => {
    const registry = new CommandRegistry();
    for (const command of ["/help", "/help help"]) {
      expect(await registry.execute(command, context)).toMatchObject({ text: expect.stringContaining("/help --search <query>") });
    }
  });

  it("keeps literal spacing in a search phrase through slash dispatch", async () => {
    const registry = new CommandRegistry();
    const execute = vi.fn<SlashCommand["execute"]>();
    registry.register({ name: "runtime-phrase", description: "Find two  words", execute });
    expect(await registry.execute("/help    --search two  words", context)).toMatchObject({ text: "/runtime-phrase — Find two  words" });
    expect(await registry.execute("/help --search two words", context)).toMatchObject({ text: expect.stringMatching(/no commands match/i) });
    expect(execute).not.toHaveBeenCalled();
  });

  it("matches descriptions and names literally, using the current registry and virtual commands once", async () => {
    const execute = vi.fn<SlashCommand["execute"]>();
    const registry: SlashCommand[] = [{ name: "search", description: "Search saved sessions", execute }];
    const help = createHelpCommand(() => registry);
    registry.push(
      { name: "runtime-command", description: "Do a LOOKUP [one] now", execute },
      { name: "runtime-command", description: "Do a LOOKUP [one] now", execute },
    );
    const text = async (args: string) => {
      const result = await help.execute(args, context);
      if (result.type !== "message") throw new Error("expected message");
      return result.text;
    };
    const match = await text("--search lookup [ONE]");
    expect(match.match(/\/runtime-command/g)).toHaveLength(1);
    expect(await text("--search TIMER")).toMatch(/no commands match/i);
    expect(await text("--search train[")).toMatch(/no commands match/i);
    expect(await text("--search SIDE QUERY")).toContain("/ps");
    expect(await text("--search RUNTIME-COMM")).toContain("/runtime-command");
    expect(await text("--search ")).toMatch(/Usage: \/help --search <query>/);
    expect(await text("search")).toBe("/search — Search saved sessions");
    expect(execute).not.toHaveBeenCalled();
  });
});
