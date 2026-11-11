import { describe, expect, it, vi } from "vitest";

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
