import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "./loop.js";
import { ConversationState } from "./conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import { updatePlanTool } from "../tools/plan.js";
import { loadPlan, savePlan } from "./planner.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "./loop.js";

class MockProvider implements LLMProvider {
  streams: StreamEvent[][];
  name = "mock";
  constructor(streams: StreamEvent[][]) {
    this.streams = streams;
  }
  stream = vi.fn((params: StreamParams) => {
    const events = this.streams.shift() ?? [];
    return (async function* () {
      void params;
      for (const event of events) {
        yield event;
      }
    })();
  });
}

function createTool(
  name: string,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    schema: {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
    },
    execute,
  };
}

async function collectEvents(
  loop: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop) {
    events.push(event);
  }
  return events;
}

describe("runAgentLoop", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), "agav-agent-loop-"));
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  it("streams text/thinking/usage and completes without tool calls", async () => {
    const provider = new MockProvider([
      [
        { type: "thinking_delta", text: "considering" },
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
        {
          type: "usage",
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
        { type: "message_end", stopReason: "end_turn" },
      ],
    ]);

    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("Hi");

    const toolRegistry = new ToolRegistry();

    const events = await collectEvents(
      runAgentLoop({ provider, conversation, toolRegistry, model: "gpt-4" }),
    );

    expect(events).toEqual([
      { type: "thinking", text: "considering" },
      { type: "streaming_text", text: "Hello" },
      { type: "streaming_text", text: " world" },
      {
        type: "usage",
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
      { type: "assistant_message_complete", text: "Hello world" },
      { type: "turn_complete" },
    ]);

    expect(conversation.getMessages()).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    ]);

    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("persists provider metadata returned with a tool call", async () => {
    const provider = new MockProvider([
      [
        { type: "tool_call_start", toolCallId: "call-1", toolName: "lookup" },
        {
          type: "tool_call_delta",
          toolCallId: "call-1",
          argsJson: "{}",
          providerMetadata: { vertexAIThoughtSignature: "opaque-signature" },
        },
        { type: "tool_call_end", toolCallId: "call-1" },
        { type: "message_end", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_end", stopReason: "stop" },
      ],
    ]);
    const conversation = new ConversationState();
    conversation.addUserMessage("look it up");
    const tools = new ToolRegistry();
    tools.register(createTool("lookup", async () => ({ output: "result", isError: false })));

    await collectEvents(runAgentLoop({ provider, conversation, toolRegistry: tools, model: "m" }));

    const toolUse = conversation.getMessages()[1]?.content[0];
    expect(toolUse).toMatchObject({
      type: "tool_use",
      toolCallId: "call-1",
      providerMetadata: { vertexAIThoughtSignature: "opaque-signature" },
    });
  });

  it("executes safe tools and continues into a follow-up provider turn", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      output: `read:${String(input.path)}`,
      isError: false,
    }));

    const provider = new MockProvider([
      [
        { type: "text_delta", text: "Checking" },
        {
          type: "tool_call_start",
          toolCallId: "tool-1",
          toolName: "read_file",
        },
        {
          type: "tool_call_delta",
          toolCallId: "tool-1",
          argsJson: '{"path":"src/index.ts"}',
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Done." },
        { type: "message_end", stopReason: "end_turn" },
      ],
    ]);

    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("inspect file");

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createTool("read_file", execute));

    const events = await collectEvents(
      runAgentLoop({ provider, conversation, toolRegistry, model: "gpt-4" }),
    );

    expect(events).toEqual([
      { type: "streaming_text", text: "Checking" },
      {
        type: "tool_call_start",
        toolName: "read_file",
        toolCallId: "tool-1",
      },
      {
        type: "tool_call_input_delta",
        toolCallId: "tool-1",
        argsJson: '{"path":"src/index.ts"}',
      },
      { type: "assistant_message_complete", text: "Checking" },
      {
        type: "tool_result",
        toolName: "read_file",
        toolCallId: "tool-1",
        output: "read:src/index.ts",
        isError: false,
        diffLines: undefined,
      },
      { type: "streaming_text", text: "Done." },
      { type: "assistant_message_complete", text: "Done." },
      { type: "turn_complete" },
    ]);

    expect(execute).toHaveBeenCalledWith({ path: "src/index.ts" });
    expect(provider.stream).toHaveBeenCalledTimes(2);

    expect(conversation.getMessages()).toEqual([
      { role: "user", content: [{ type: "text", text: "inspect file" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking" },
          {
            type: "tool_use",
            toolCallId: "tool-1",
            toolName: "read_file",
            toolInput: { path: "src/index.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "tool-1",
            toolResult: "read:src/index.ts",
            isError: false,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
  });

  it("requests confirmation for write tools, includes diff preview, and honors always approval", async () => {
    const targetFile = join(cwd, "note.txt");
    await writeFile(targetFile, "before\nvalue\nafter\n", "utf8");

    const editExecute = vi.fn(async (input: Record<string, unknown>) => ({
      output: `edited:${String(input.path)}`,
      isError: false,
    }));
    const shellExecute = vi.fn(async () => ({
      output: "shell ok",
      isError: false,
    }));

    const provider = new MockProvider([
      [
        {
          type: "tool_call_start",
          toolCallId: "edit-1",
          toolName: "edit_file",
        },
        {
          type: "tool_call_delta",
          toolCallId: "edit-1",
          argsJson: JSON.stringify({
            path: targetFile,
            old_string: "value",
            new_string: "changed",
          }),
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call_start",
          toolCallId: "shell-1",
          toolName: "shell",
        },
        {
          type: "tool_call_delta",
          toolCallId: "shell-1",
          argsJson: '{"command":"pwd"}',
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "complete" },
        { type: "message_end", stopReason: "end_turn" },
      ],
    ]);

    const confirmTool = vi.fn().mockResolvedValueOnce("always");

    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("make edits");

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createTool("edit_file", editExecute));
    toolRegistry.register(createTool("shell", shellExecute));

    const events = await collectEvents(
      runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: "gpt-4",
        confirmTool,
      }),
    );

    const confirmation = events.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "tool_confirmation_request",
    );
    expect(confirmation).toBeDefined();
    expect(confirmation).toMatchObject({
      type: "tool_confirmation_request",
      toolName: "edit_file",
      toolCallId: "edit-1",
      input: {
        path: targetFile,
        old_string: "value",
        new_string: "changed",
      },
    });
    expect((confirmation as any)?.diffLines).toEqual([
      { type: "context", lineNo: 1, text: "before" },
      { type: "remove", lineNo: 2, text: "value" },
      { type: "add", lineNo: 2, text: "changed" },
      { type: "context", lineNo: 3, text: "after" },
      { type: "context", lineNo: 4, text: "" },
    ]);

    expect(confirmTool).toHaveBeenCalledTimes(1);
    expect(editExecute).toHaveBeenCalledTimes(1);
    expect(shellExecute).toHaveBeenCalledTimes(1);

    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "edit_file",
      toolCallId: "edit-1",
      output: `edited:${targetFile}`,
      isError: false,
      diffLines: undefined,
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "shell",
      toolCallId: "shell-1",
      output: "shell ok",
      isError: false,
      diffLines: undefined,
    });
  });

  it("denies write tools in deny-writes mode without executing them", async () => {
    const execute = vi.fn(async () => ({
      output: "should not run",
      isError: false,
    }));

    const provider = new MockProvider([
      [
        {
          type: "tool_call_start",
          toolCallId: "write-1",
          toolName: "write_file",
        },
        {
          type: "tool_call_delta",
          toolCallId: "write-1",
          argsJson: '{"path":"blocked.txt","content":"x"}',
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "cannot do that" },
        { type: "message_end", stopReason: "end_turn" },
      ],
    ]);

    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("write file");

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createTool("write_file", execute));

    const events = await collectEvents(
      runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: "gpt-4",
        permissionMode: "deny-writes",
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "write_file",
      output: "Write operations are denied (--deny-writes mode).",
      isError: true,
    });
  });

  it("denies write tools without confirmation handler in headless mode", async () => {
    const execute = vi.fn(async () => ({
      output: "should not run",
      isError: false,
    }));

    const provider = new MockProvider([
      [
        {
          type: "tool_call_start",
          toolCallId: "write-1",
          toolName: "write_file",
        },
        {
          type: "tool_call_delta",
          toolCallId: "write-1",
          argsJson: '{"path":"blocked.txt","content":"x"}',
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "cannot do that" },
        { type: "message_end", stopReason: "end_turn" },
      ],
    ]);

    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("write file");

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createTool("write_file", execute));

    // No confirmTool provided — simulates headless/pipe mode.
    // Default permissionMode is "ask", so without a handler there is no way
    // to approve the tool; it must be denied rather than silently executed.
    const events = await collectEvents(
      runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: "gpt-4",
        // confirmTool intentionally omitted (headless mode)
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "write_file",
      output: "Tool 'write_file' requires confirmation but no confirmation handler is available (headless mode).",
      isError: true,
    });
  });

  describe("destructive commands in headless mode", () => {
    const DESTRUCTIVE = "git clean -fdx";

    const runDestructive = async (
      execute: ReturnType<typeof vi.fn>,
      params: { allowedTools?: string[]; permissionMode?: "ask" | "auto-accept" | "deny-writes" },
    ) => {
      const provider = new MockProvider([
        [
          { type: "tool_call_start", toolCallId: "cmd-1", toolName: "run_command" },
          {
            type: "tool_call_delta",
            toolCallId: "cmd-1",
            argsJson: JSON.stringify({ command: DESTRUCTIVE }),
          },
          { type: "message_end", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "message_end", stopReason: "end_turn" },
        ],
      ]);

      const conversation = new ConversationState();
      conversation.setModel("gpt-4");
      conversation.addUserMessage("clean the tree");

      const toolRegistry = new ToolRegistry();
      toolRegistry.register(createTool("run_command", execute));

      // confirmTool intentionally omitted throughout — this is headless mode.
      return collectEvents(
        runAgentLoop({ provider, conversation, toolRegistry, model: "gpt-4", ...params }),
      );
    };

    it("runs one when the allowlist names it", async () => {
      const execute = vi.fn(async () => ({ output: "cleaned", isError: false }));

      await runDestructive(execute, { allowedTools: [`run_command:${DESTRUCTIVE}`] });

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("still blocks one behind a blanket run_command grant", async () => {
      const execute = vi.fn(async () => ({ output: "should not run", isError: false }));

      const events = await runDestructive(execute, { allowedTools: ["run_command"] });

      expect(execute).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        type: "tool_result",
        toolName: "run_command",
        output: "Tool 'run_command' requires confirmation but no confirmation handler is available (headless mode).",
        isError: true,
      });
    });

    it("still blocks one under --auto-accept", async () => {
      const execute = vi.fn(async () => ({ output: "should not run", isError: false }));

      await runDestructive(execute, { permissionMode: "auto-accept" });

      expect(execute).not.toHaveBeenCalled();
    });

    it("lets --deny-writes outrank a naming allowlist rule", async () => {
      const execute = vi.fn(async () => ({ output: "should not run", isError: false }));

      const events = await runDestructive(execute, {
        allowedTools: [`run_command:${DESTRUCTIVE}`],
        permissionMode: "deny-writes",
      });

      expect(execute).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        type: "tool_result",
        toolName: "run_command",
        output: "Write operations are denied (--deny-writes mode).",
        isError: true,
      });
    });
  });

  it("handles invalid tool JSON by passing raw input through to the registry", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      output: JSON.stringify(input),
      isError: false,
    }));

    const provider = new MockProvider([
      [
        {
          type: "tool_call_start",
          toolCallId: "tool-1",
          toolName: "shell",
        },
        {
          type: "tool_call_delta",
          toolCallId: "tool-1",
          argsJson: "{not-json",
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [{ type: "message_end", stopReason: "end_turn" }],
    ]);

    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("broken args");

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createTool("shell", execute));

    await collectEvents(
      runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: "gpt-4",
        confirmTool: vi.fn().mockResolvedValue("yes"),
      }),
    );

    expect(execute).toHaveBeenCalledWith({ raw: "{not-json" });
  });

  it("yields provider and thrown errors", async () => {
    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("hi");

    const toolRegistry = new ToolRegistry();

    const providerError = new MockProvider([
      [{ type: "error", error: new Error("provider failed") }],
    ]);
    const providerThrow: LLMProvider = {
      name: "throwing",
      async *stream() {
        throw new Error("stream exploded");
      },
    };

    const providerErrorEvents = await collectEvents(
      runAgentLoop({
        provider: providerError,
        conversation,
        toolRegistry,
        model: "gpt-4",
      }),
    );
    expect(providerErrorEvents).toEqual([
      { type: "error", error: new Error("provider failed") },
    ]);

    const conversation2 = new ConversationState();
    conversation2.setModel("gpt-4");
    conversation2.addUserMessage("hi");
    const thrownEvents = await collectEvents(
      runAgentLoop({
        provider: providerThrow,
        conversation: conversation2,
        toolRegistry,
        model: "gpt-4",
      }),
    );
    expect(thrownEvents).toEqual([
      { type: "error", error: new Error("stream exploded") },
    ]);
  });

  it("aborts when the signal is already aborted during streaming", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new MockProvider([
      [{ type: "text_delta", text: "partial" }],
    ]);

    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("stop");

    const toolRegistry = new ToolRegistry();

    const events = await collectEvents(
      runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: "gpt-4",
        signal: controller.signal,
      }),
    );

    expect(events).toEqual([
      { type: "error", error: new Error("Aborted") },
    ]);
  });

  it("tracks plan updates through the real update_plan tool", async () => {
    const plan = {
      goal: "Ship loop tests",
      createdAt: new Date().toISOString(),
      currentStep: 0,
      steps: [
        {
          id: 1,
          title: "Write tests",
          description: "Add coverage",
          status: "pending" as const,
        },
        {
          id: 2,
          title: "Run suite",
          description: "Verify all tests",
          status: "pending" as const,
          verifyCommand: "pnpm test",
        },
      ],
    };
    await savePlan(plan);

    const provider = new MockProvider([
      [
        {
          type: "tool_call_start",
          toolCallId: "plan-1",
          toolName: "update_plan",
        },
        {
          type: "tool_call_delta",
          toolCallId: "plan-1",
          argsJson: '{"step":1,"status":"in_progress"}',
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call_start",
          toolCallId: "plan-2",
          toolName: "update_plan",
        },
        {
          type: "tool_call_delta",
          toolCallId: "plan-2",
          argsJson: '{"step":1,"status":"done"}',
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_call_start",
          toolCallId: "plan-3",
          toolName: "update_plan",
        },
        {
          type: "tool_call_delta",
          toolCallId: "plan-3",
          argsJson: '{"step":2,"status":"done"}',
        },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "plan complete" },
        { type: "message_end", stopReason: "end_turn" },
      ],
    ]);

    const conversation = new ConversationState();
    conversation.setModel("gpt-4");
    conversation.addUserMessage("follow the plan");

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(updatePlanTool);

    const events = await collectEvents(
      runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: "gpt-4",
      }),
    );

    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "update_plan",
      toolCallId: "plan-1",
      output: "Step 1 marked in_progress. Progress: 0/2 steps done.",
      isError: false,
      diffLines: undefined,
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "update_plan",
      toolCallId: "plan-2",
      output: "Step 1 marked done. Progress: 1/2 steps done.",
      isError: false,
      diffLines: undefined,
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "update_plan",
      toolCallId: "plan-3",
      output: "Step 2 marked done. All 2 steps complete! Plan finished.",
      isError: false,
      diffLines: undefined,
    });

    const saved = await loadPlan();
    expect(saved?.steps.map((step) => step.status)).toEqual(["done", "done"]);
    expect(saved?.currentStep).toBe(-1);
  });
});
