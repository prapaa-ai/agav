import { describe, expect, it, vi } from "vitest";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import { contextCommand } from "../commands/context.js";
import type { CommandContext } from "../commands/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { estimateTokens } from "../utils/tokens.js";

vi.mock("../utils/system-prompt.js", () => ({ buildSystemPrompt: async () => "baseline" }));
vi.mock("../skills/loader.js", () => ({ getCachedSkills: () => [{ name: "demo" }], buildSkillCatalog: () => "skill catalog" }));

function setup() {
  const conversation = new ConversationState();
  conversation.setModel("mock");
  const toolRegistry = new ToolRegistry();
  const context = {
    conversation, toolRegistry, config: { model: "mock", provider: "openai", systemPrompt: "custom prompt" },
    getDebugState: () => ({ mcpServers: [], tokenUsage: { inputTokens: 11_900_000, outputTokens: 68_400, cacheReadTokens: 11_200_000, cacheWriteTokens: 0 } }),
  } as unknown as CommandContext;
  return { conversation, toolRegistry, context };
}
async function output(context: CommandContext) {
  const result = await contextCommand.execute("", context);
  expect(result.type).toBe("message");
  return result.type === "message" ? result.text : "";
}

describe("/context accounting", () => {
  it("separates estimated context occupancy from cumulative session usage", async () => {
    const { context } = setup();
    const text = await output(context);
    expect(text).toContain("Estimated context window usage");
    expect(text).toContain("Session totals (all requests, not context occupancy)");
    expect(text).toMatch(/11\.9m ↑ 68\.4k ↓ 11\.2m ⇢/);
    expect(text).toMatch(new RegExp(`System prompt\\s+${estimateTokens("custom prompt")}\\s`));
  });

  it("classifies MCP tools using their server metadata rather than a name prefix", async () => {
    const { context, toolRegistry } = setup();
    toolRegistry.register({ schema: { name: "scraper__fetch", description: "Fetch", inputSchema: { type: "object" } }, mcpServerName: "scraper", execute: async () => ({ output: "", isError: false }) });
    const text = await output(context);
    expect(text).toContain("MCP tools (1)");
    expect(text).toContain("Non-MCP tools (0)");
  });

  it("counts the actual effective prompt exactly once during streaming and after completion", async () => {
    const { context, conversation, toolRegistry } = setup();
    const prompt = "custom prompt\n\nproject instructions and memories\n\nskill catalog";
    conversation.addUserMessage("hello");
    const loop = runAgentLoop({
      provider: { name: "mock", stream: async function* () { yield { type: "text_delta", text: "in flight" }; } },
      conversation, toolRegistry, model: "mock", systemPrompt: prompt, iterationsBudget: { remaining: 2, total: 2 },
    });
    expect((await loop.next()).value).toEqual({ type: "streaming_text", text: "in flight" });
    context.isLoading = true;
    const text = await output(context);
    expect(text).toContain("excludes in-flight output");
    expect(text).toMatch(new RegExp(`System prompt \\+ skills\\s+${estimateTokens(prompt)}\\s`));
    expect(text).not.toMatch(/Skills \(1\)\s+\d/);
    expect(text).toMatch(new RegExp(`Used\\s+${estimateTokens(prompt) + conversation.tokenCount}\\s`));
    for await (const _event of loop) { /* Finish the turn. */ }
    context.isLoading = false;
    const idle = await output(context);
    expect(idle).not.toContain("excludes in-flight output");
    expect(idle).toMatch(new RegExp(`Used\\s+${estimateTokens(prompt) + conversation.tokenCount}\\s`));
    conversation.clear();
    expect(await output(context)).toMatch(new RegExp(`System prompt\\s+${estimateTokens("custom prompt")}\\s`));
  });
});
