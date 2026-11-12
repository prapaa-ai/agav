import { describe, expect, it } from "vitest";
import { createAgentTargetCommand } from "../agents/targeting.js";
import type { AgentDefinition } from "../agents/types.js";
import type { CommandContext } from "../commands/types.js";

// createAgentTargetCommand never reads the context; it only builds a payload.
const context = {} as CommandContext;

function makeAgent(overrides: { name?: string; alias?: string; description?: string } = {}): AgentDefinition {
  return {
    manifest: {
      name: overrides.name ?? "researcher",
      description: overrides.description ?? "Finds and summarizes sources.",
      version: "1.0.0",
    },
    systemPrompt: "You are a test agent.",
    tools: [],
    origin: "project",
    path: "/tmp/agents/researcher",
    ...(overrides.alias !== undefined ? { alias: overrides.alias } : {}),
  };
}

describe("agents/targeting createAgentTargetCommand", () => {
  it("names the command after the manifest name when there is no alias", () => {
    const command = createAgentTargetCommand(makeAgent());

    expect(command.name).toBe("researcher");
    expect(command.description).toBe("[agent] Finds and summarizes sources.");
    expect(command.usage).toBe(
      "Usage: /researcher <query>\n\nSend a query directly to the researcher agent.\nFinds and summarizes sources.",
    );
  });

  it("prefers the alias over the manifest name", async () => {
    const command = createAgentTargetCommand(makeAgent({ name: "researcher", alias: "researcher-project" }));

    expect(command.name).toBe("researcher-project");
    expect(command.usage).toContain("Usage: /researcher-project <query>");
    expect(command.usage).toContain("Send a query directly to the researcher-project agent.");
    await expect(command.execute("hello", context)).resolves.toEqual({
      type: "agent_invoke",
      agentName: "researcher-project",
      query: "hello",
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   \t\n  "],
  ])("returns the usage message for an %s query", async (_label, args) => {
    const command = createAgentTargetCommand(makeAgent());

    await expect(command.execute(args, context)).resolves.toEqual({
      type: "message",
      text: "Usage: /researcher <query>\n\nSend a query directly to the researcher agent.\nFinds and summarizes sources.",
    });
  });

  it("returns an agent_invoke payload with the agent name and query", async () => {
    const command = createAgentTargetCommand(makeAgent());

    await expect(command.execute("find recent papers on RAG", context)).resolves.toEqual({
      type: "agent_invoke",
      agentName: "researcher",
      query: "find recent papers on RAG",
    });
  });

  it("trims only the outer whitespace of the query", async () => {
    const command = createAgentTargetCommand(makeAgent());

    const result = await command.execute("  \t first line\n  second   line \n ", context);

    expect(result).toEqual({
      type: "agent_invoke",
      agentName: "researcher",
      query: "first line\n  second   line",
    });
  });

  it("keeps a 100-character description whole", () => {
    const description = "a".repeat(100);
    const command = createAgentTargetCommand(makeAgent({ description }));

    expect(command.description).toBe(`[agent] ${description}`);
  });

  it("truncates a 101-character description to 97 characters plus an ellipsis", () => {
    const description = "b".repeat(101);
    const command = createAgentTargetCommand(makeAgent({ description }));

    expect(command.description).toBe(`[agent] ${"b".repeat(97)}...`);
    expect(command.description.length).toBe("[agent] ".length + 100);
  });

  it("keeps the full description in the usage text even when the summary is truncated", async () => {
    const description = "c".repeat(150);
    const command = createAgentTargetCommand(makeAgent({ description }));

    expect(command.usage?.endsWith(description)).toBe(true);
    const result = await command.execute("", context);
    expect(result).toEqual({
      type: "message",
      text: `Usage: /researcher <query>\n\nSend a query directly to the researcher agent.\n${description}`,
    });
  });
});
