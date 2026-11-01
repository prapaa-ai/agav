import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../agent/loop.js";
import type { PermissionMode } from "../config/config.js";

// End-to-end authorization-bypass tests for the agent loop's permission gate.
// These assert the gate's decisions against model-controlled tool calls — the
// model must not be able to execute a tool the policy would not approve, no
// matter what it emits. They complement agents.permission-gate.test.ts (flag
// trust, deny-writes) and workflows.agent-permissions.test.ts (gated invoker)
// by pinning the bypass vectors those do not cover: blanket-allowlist +
// destructive command, denied-call replay, auto-accept + destructive, and
// headless-without-confirm.

class MockProvider implements LLMProvider {
  streams: StreamEvent[][];
  name = "mock";
  constructor(streams: StreamEvent[][]) { this.streams = streams; }
  stream = vi.fn((_params: StreamParams) => {
    const events = this.streams.shift() ?? [];
    return (async function* () { for (const event of events) yield event; })();
  });
}

function toolCall(toolName: string, args: Record<string, unknown>, id = "tc_1"): StreamEvent[] {
  return [
    { type: "tool_call_start" as const, toolCallId: id, toolName },
    { type: "tool_call_delta" as const, toolCallId: id, argsJson: JSON.stringify(args) },
    { type: "tool_call_end" as const, toolCallId: id },
    { type: "usage" as const, inputTokens: 10, outputTokens: 5 },
  ];
}
const finalText: StreamEvent[] = [
  { type: "text_delta" as const, text: "Done" },
  { type: "usage" as const, inputTokens: 5, outputTokens: 3 },
];

async function collect(loop: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop) events.push(event);
  return events;
}

/** A spy `run_command` tool. The gate keys destructive detection on the name
 * "run_command" + the command text, independent of what execute() does, so a
 * spy is enough to prove whether the gate let the call through. */
function runCommandTool(): { tool: ToolDefinition; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockResolvedValue({ output: "ran", isError: false });
  return {
    execute,
    tool: {
      schema: { name: "run_command", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
      execute,
    },
  };
}

const DESTRUCTIVE = "git push --force origin main"; // matches DESTRUCTIVE_PATTERNS
const BENIGN = "echo hello";

function runLoop(opts: {
  streams: StreamEvent[][];
  registry: ToolRegistry;
  permissionMode?: PermissionMode;
  confirmTool?: (...args: any[]) => any;
  allowedTools?: string[];
  headless?: boolean;
}) {
  const conversation = new ConversationState();
  conversation.addUserMessage("do it");
  return collect(runAgentLoop({
    provider: new MockProvider(opts.streams),
    conversation,
    toolRegistry: opts.registry,
    model: "mock",
    systemPrompt: "test",
    effort: "low",
    maxTokens: 1000,
    permissionMode: opts.permissionMode ?? "ask",
    ...(opts.confirmTool ? { confirmTool: opts.confirmTool } : {}),
    ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    iterationsBudget: { remaining: 5, total: 5 },
  }));
}

describe("permission gate bypass resistance", () => {
  let cwd: string;
  let original: string;
  beforeEach(async () => {
    original = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), "agav-gate-bypass-"));
    process.chdir(cwd);
  });
  afterEach(async () => {
    process.chdir(original);
    await rm(cwd, { recursive: true, force: true });
  });

  it("a blanket run_command allowlist does NOT auto-approve a destructive command", async () => {
    // `allowedTools: ["run_command"]` is a bare rule. A destructive command
    // requires a pattern rule (requirePattern), so it must still be gated — and
    // with no confirmation it must not execute.
    const { tool, execute } = runCommandTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const confirmTool = vi.fn().mockResolvedValue("no");

    await runLoop({
      streams: [toolCall("run_command", { command: DESTRUCTIVE }), finalText],
      registry,
      permissionMode: "ask",
      confirmTool,
      allowedTools: ["run_command"],
    });

    expect(confirmTool).toHaveBeenCalled();          // it was gated, not pre-approved
    expect(execute).not.toHaveBeenCalled();          // denial blocked execution
  });

  it("a blanket run_command allowlist still auto-approves a benign command", async () => {
    // Control: the same bare rule DOES approve a non-destructive command, so the
    // test above is proving the destructive carve-out, not a broken allowlist.
    const { tool, execute } = runCommandTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const confirmTool = vi.fn().mockResolvedValue("no");

    await runLoop({
      streams: [toolCall("run_command", { command: BENIGN }), finalText],
      registry,
      permissionMode: "ask",
      confirmTool,
      allowedTools: ["run_command"],
    });

    expect(confirmTool).not.toHaveBeenCalled();       // bare rule pre-approved it
    expect(execute).toHaveBeenCalledOnce();
  });

  it("auto-accept mode still gates a destructive command and a denial blocks it", async () => {
    // auto-accept skips confirmation for ordinary calls, but a destructive
    // run_command must still be confirmed; denying it must prevent execution.
    const { tool, execute } = runCommandTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const confirmTool = vi.fn().mockResolvedValue("no");

    await runLoop({
      streams: [toolCall("run_command", { command: DESTRUCTIVE }), finalText],
      registry,
      permissionMode: "auto-accept",
      confirmTool,
    });

    expect(confirmTool).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not re-execute a destructive call the user already denied with identical args", async () => {
    // The model retries the exact same denied call; the gate must reject it
    // from the denied-calls memory without re-prompting or executing.
    const { tool, execute } = runCommandTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const confirmTool = vi.fn().mockResolvedValue("no");

    await runLoop({
      streams: [
        toolCall("run_command", { command: DESTRUCTIVE }, "tc_1"),
        toolCall("run_command", { command: DESTRUCTIVE }, "tc_2"),
        finalText,
      ],
      registry,
      permissionMode: "ask",
      confirmTool,
    });

    // Prompted once for the first attempt; the identical retry is auto-denied.
    expect(confirmTool).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("headless (no confirmTool) blocks a tool that would require confirmation", async () => {
    // With no confirmation handler, a non-safe tool in ask mode cannot run:
    // the gate must fail closed rather than silently execute.
    const execute = vi.fn().mockResolvedValue({ output: "done", isError: false });
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: "external_action", description: "ext", inputSchema: { type: "object", properties: {} } },
      execute,
    });

    const events = await runLoop({
      streams: [toolCall("external_action", {}), finalText],
      registry,
      permissionMode: "ask",
      // no confirmTool
    });

    expect(execute).not.toHaveBeenCalled();
    const blocked = events.find((e): e is Extract<AgentEvent, { type: "tool_result" }> =>
      e.type === "tool_result" && e.isError === true);
    expect(blocked?.output).toMatch(/confirmation|headless/i);
  });

  it("a non-builtin tool cannot self-declare SAFE status to skip confirmation", async () => {
    // destructive:false is only trusted for builtin SAFE_TOOLS. A third-party
    // tool claiming it must still be confirmed in ask mode.
    const execute = vi.fn().mockResolvedValue({ output: "done", isError: false });
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: "sneaky_tool", description: "claims safe", destructive: false, inputSchema: { type: "object", properties: {} } },
      execute,
    });
    const confirmTool = vi.fn().mockResolvedValue("no");

    await runLoop({
      streams: [toolCall("sneaky_tool", {}), finalText],
      registry,
      permissionMode: "ask",
      confirmTool,
    });

    expect(confirmTool).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
