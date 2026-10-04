import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../agent/loop.js";
import { executeNativeAgent } from "../agents/executor.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../agent/loop.js";

class MockProvider implements LLMProvider {
  streams: StreamEvent[][];
  name = "mock";
  constructor(streams: StreamEvent[][]) {
    this.streams = streams;
  }
  stream = vi.fn((_params: StreamParams) => {
    const events = this.streams.shift() ?? [];
    return (async function* () {
      for (const event of events) yield event;
    })();
  });
}

function makeToolCallStream(toolName: string, args: Record<string, unknown>): StreamEvent[] {
  return [
    { type: "tool_call_start" as const, toolCallId: "tc_1", toolName },
    { type: "tool_call_delta" as const, toolCallId: "tc_1", argsJson: JSON.stringify(args) },
    { type: "tool_call_end" as const, toolCallId: "tc_1" },
    { type: "usage" as const, inputTokens: 10, outputTokens: 5 },
  ];
}

async function collectEvents(loop: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop) events.push(event);
  return events;
}

describe("permission gate: destructive flag trust", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), "agav-perm-gate-"));
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  it("non-builtin tool with destructive:false still triggers confirmation in ask mode", async () => {
    const externalTool: ToolDefinition = {
      schema: {
        name: "external_agent",
        description: "An external agent tool",
        destructive: false,
        inputSchema: { type: "object", properties: { task: { type: "string" } } },
      },
      execute: vi.fn().mockResolvedValue({ output: "done", isError: false }),
    };

    const registry = new ToolRegistry();
    registry.register(externalTool);

    const confirmTool = vi.fn().mockResolvedValue("yes");

    const provider = new MockProvider([
      makeToolCallStream("external_agent", { task: "do something" }),
      [{ type: "text_delta" as const, text: "Done" }, { type: "usage" as const, inputTokens: 5, outputTokens: 3 }],
    ]);

    const conversation = new ConversationState();
    conversation.addUserMessage("test");

    await collectEvents(
      runAgentLoop({
        provider,
        conversation,
        toolRegistry: registry,
        model: "mock",
        systemPrompt: "test",
        effort: "low",
        maxTokens: 1000,
        confirmTool,
        permissionMode: "ask",
        maxIterations: 2,
      })
    );

    // The tool is not in SAFE_TOOLS, so even with destructive:false it should prompt
    expect(confirmTool).toHaveBeenCalled();
  });

  it("full-access native execution does not downgrade to deny-writes without a confirmation callback", async () => {
    const tool = {
      schema: {
        name: "write_record",
        description: "Write a record",
        destructive: true,
        inputSchema: { type: "object", properties: {} },
      },
      execute: vi.fn().mockResolvedValue({ output: "written", isError: false }),
    };
    const provider = new MockProvider([
      makeToolCallStream("write_record", {}),
      [{ type: "text_delta" as const, text: "Done" }, { type: "usage" as const, inputTokens: 5, outputTokens: 3 }],
    ]);
    const agent = {
      manifest: { name: "writer", description: "Writes", version: "1.0.0" },
      systemPrompt: "test",
      tools: [tool],
      origin: "global" as const,
      path: cwd,
    };

    await expect(executeNativeAgent(agent, "write it", {
      provider,
      config: { model: "mock", effort: "low", maxTokens: 1000 } as any,
      permissionMode: "auto-accept",
    })).resolves.toBe("Done");

    expect(tool.execute).toHaveBeenCalled();
  });

  it("preserves the turn signal when injecting native agent credentials", async () => {
    const controller = new AbortController();
    const tool: ToolDefinition = {
      schema: { name: "inspect", description: "test", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ output: "done", isError: false })),
    };
    const provider = new MockProvider([makeToolCallStream("inspect", {}), [{ type: "text_delta", text: "Done" }]]);
    await executeNativeAgent({
      manifest: { name: "signal-test", description: "test", version: "1.0.0" },
      systemPrompt: "test", tools: [tool], origin: "bundled", path: cwd,
    }, "inspect", { provider, config: { model: "mock", effort: "low", maxTokens: 1000 } as any, signal: controller.signal, permissionMode: "auto-accept" });
    expect(tool.execute).toHaveBeenCalledWith({}, { env: {}, signal: controller.signal });
  });

  it("deny-writes mode blocks non-builtin tool regardless of destructive flag", async () => {
    const agentTool: ToolDefinition = {
      schema: {
        name: "jira_agent",
        description: "Jira agent",
        destructive: false,
        inputSchema: { type: "object", properties: { task: { type: "string" } } },
      },
      execute: vi.fn().mockResolvedValue({ output: "done", isError: false }),
    };

    const registry = new ToolRegistry();
    registry.register(agentTool);

    const provider = new MockProvider([
      makeToolCallStream("jira_agent", { task: "create ticket" }),
      [{ type: "text_delta" as const, text: "Blocked" }, { type: "usage" as const, inputTokens: 5, outputTokens: 3 }],
    ]);

    const conversation = new ConversationState();
    conversation.addUserMessage("test");

    const events = await collectEvents(
      runAgentLoop({
        provider,
        conversation,
        toolRegistry: registry,
        model: "mock",
        systemPrompt: "test",
        effort: "low",
        maxTokens: 1000,
        permissionMode: "deny-writes",
        maxIterations: 2,
      })
    );

    // Tool should NOT have been executed
    expect(agentTool.execute).not.toHaveBeenCalled();

    // Should see an error result about denied/confirmation
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    const result = toolResults[0] as any;
    expect(result.isError).toBe(true);
  });

  it("allows process introspection without confirmation but prompts before process start", async () => {
    const processTool: ToolDefinition = {
      schema: {
        name: "process",
        description: "process tool",
        inputSchema: { type: "object", properties: {} },
      },
      execute: vi.fn().mockResolvedValue({ output: "ok", isError: false }),
    };

    const registry = new ToolRegistry();
    registry.register(processTool);
    const confirmTool = vi.fn().mockResolvedValue("yes");

    const conversation = new ConversationState();
    conversation.addUserMessage("manage process");
    const provider = new MockProvider([
      makeToolCallStream("process", { action: "list" }),
      makeToolCallStream("process", { action: "start", command: "npm run dev" }),
    ]);

    await collectEvents(runAgentLoop({
      provider,
      conversation,
      toolRegistry: registry,
      model: "mock",
      confirmTool,
      permissionMode: "ask",
      maxIterations: 2,
    }));

    expect(processTool.execute).toHaveBeenCalledTimes(2);
    expect(confirmTool).toHaveBeenCalledTimes(1);
    // A fourth argument carries the MCP server name, which is undefined for a
    // built-in tool such as process.
    expect(confirmTool).toHaveBeenCalledWith(
      "process",
      { action: "start", command: "npm run dev" },
      undefined,
      undefined,
    );
  });
});
