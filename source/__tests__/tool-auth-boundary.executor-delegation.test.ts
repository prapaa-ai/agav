import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Delegation-path coverage for the tool-auth boundary (follow-up to #589 review).
//
// The sibling suite (tool-auth-boundary.surfaces.test.ts) drives the gate
// through runAgentLoop directly. This file proves the SAME guarantees hold when
// a native agent is run via executeNativeAgent — i.e. the executor actually
// forwards confirmTool / permissionMode and installs the requested built-in, so
// a destructive command is still confirmed and a denial blocks the *installed,
// reachable* run_command. The built-in shell is mocked with a harmless spy so no
// real command runs; the gate's own destructive detection (utils/sandbox) is
// independent of the shell module and is exercised unmocked.
//
// The mock is isolated to this file so it cannot leak into other suites.

const shellSpy = vi.fn(async () => ({ output: "ran", isError: false }));
const runCommandSchema = {
  name: "run_command",
  description: "Run a shell command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
} as const;

vi.mock("../tools/shell.js", () => {
  const shellTool = { schema: { ...runCommandSchema }, execute: shellSpy };
  return {
    shellTool,
    // createShellTool() returns the same spy-backed tool the factory installs.
    createShellTool: () => ({ schema: { ...runCommandSchema }, execute: shellSpy }),
    isSandboxAvailable: () => false,
  };
});

// Imported AFTER the mock so the factory picks up the mocked shell tool.
const { executeNativeAgent } = await import("../agents/executor.js");
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { AgentDefinition } from "../agents/types.js";

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

let cwd: string;
let original: string;
beforeEach(async () => {
  shellSpy.mockClear();
  original = process.cwd();
  cwd = await mkdtemp(join(tmpdir(), "agav-exec-deleg-"));
  process.chdir(cwd);
});
afterEach(async () => {
  process.chdir(original);
  await rm(cwd, { recursive: true, force: true });
});

/** A native agent that requests the real built-in run_command (installed by the
 *  factory as our harmless spy) rather than defining its own tool. */
function agentRequestingRunCommand(): AgentDefinition {
  return {
    manifest: { name: "runner", description: "runs commands", version: "1.0.0", "native-tools": ["run_command"] },
    systemPrompt: "do work",
    tools: [],
    origin: "global",
    path: cwd,
  } as unknown as AgentDefinition;
}

describe("tool-auth boundary via executeNativeAgent (real delegation path)", () => {
  it("forwards confirmation: a destructive command is confirmed under auto-accept and a denial blocks the installed run_command", async () => {
    const streams = [toolCall("run_command", { command: "git push --force origin main" }), finalText];
    const advertised: string[] = [];
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => {
        for (const t of params.tools ?? []) advertised.push(t.name);
        const events = streams.shift() ?? [];
        return (async function* () { for (const e of events) yield e; })();
      }),
    };
    const confirmTool = vi.fn().mockResolvedValue("no");

    await executeNativeAgent(agentRequestingRunCommand(), "force push please", {
      provider,
      config: { model: "m", effort: "low", maxTokens: 1000, maxIterations: 5 } as any,
      permissionMode: "auto-accept",
      confirmTool,
      iterationsBudget: { remaining: 5, total: 5 },
    });

    expect(advertised).toContain("run_command");   // the built-in was installed & advertised
    expect(confirmTool).toHaveBeenCalled();         // executor forwarded the gate's confirmation
    expect(shellSpy).not.toHaveBeenCalled();        // denial blocked the reachable built-in
  });

  it("control: a benign command through the same executor path reaches the installed run_command", async () => {
    const provider = new MockProvider([toolCall("run_command", { command: "echo hello" }), finalText]);
    const confirmTool = vi.fn().mockResolvedValue("no");

    await executeNativeAgent(agentRequestingRunCommand(), "say hello", {
      provider,
      config: { model: "m", effort: "low", maxTokens: 1000, maxIterations: 5 } as any,
      permissionMode: "auto-accept",
      confirmTool,
      iterationsBudget: { remaining: 5, total: 5 },
    });

    expect(confirmTool).not.toHaveBeenCalled();     // benign command auto-approved
    expect(shellSpy).toHaveBeenCalledOnce();         // and the installed built-in actually ran
  });

  it("forwards deny-writes: a destructive command is blocked without prompting", async () => {
    const provider = new MockProvider([toolCall("run_command", { command: "rm -rf /" }), finalText]);
    const confirmTool = vi.fn().mockResolvedValue("yes");

    await executeNativeAgent(agentRequestingRunCommand(), "delete everything", {
      provider,
      config: { model: "m", effort: "low", maxTokens: 1000, maxIterations: 5 } as any,
      permissionMode: "deny-writes",
      confirmTool,
      iterationsBudget: { remaining: 5, total: 5 },
    });

    expect(shellSpy).not.toHaveBeenCalled();
  });

  it("fails closed: a destructive command cannot run when no confirmation callback is available", async () => {
    // No confirmTool: the gate must not silently execute a destructive command.
    const provider = new MockProvider([toolCall("run_command", { command: "git reset --hard HEAD~5" }), finalText]);

    await executeNativeAgent(agentRequestingRunCommand(), "nuke history", {
      provider,
      config: { model: "m", effort: "low", maxTokens: 1000, maxIterations: 5 } as any,
      permissionMode: "ask",
      // no confirmTool
      iterationsBudget: { remaining: 5, total: 5 },
    });

    expect(shellSpy).not.toHaveBeenCalled();
  });
});
