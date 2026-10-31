import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../agent/loop.js";
import type { AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { ToolDefinition } from "../tools/types.js";
import render from "../ink/render.js";
import ToolConfirm from "../components/tool-confirm.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

class MockProvider implements LLMProvider {
  name = "mock";
  constructor(private streams: StreamEvent[][]) {}
  stream = vi.fn((params: StreamParams) => {
    const events = this.streams.shift() ?? [];
    return (async function* () {
      void params;
      for (const event of events) yield event;
    })();
  });
}

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { schema: { name, description: name, inputSchema: { type: "object", properties: {} } }, execute };
}

async function runWrite(toolName: string, input: Record<string, unknown>, permissionMode: "ask" | "auto-accept" = "ask") {
  const provider = new MockProvider([
    [
      { type: "tool_call_start", toolCallId: "w-1", toolName },
      { type: "tool_call_delta", toolCallId: "w-1", argsJson: JSON.stringify(input) },
      { type: "message_end", stopReason: "tool_use" },
    ],
    [{ type: "text_delta", text: "done" }, { type: "message_end", stopReason: "end_turn" }],
  ]);
  const execute = vi.fn(async () => ({ output: "ok", isError: false }));
  const registry = new ToolRegistry();
  registry.register(tool(toolName, execute));
  const confirmTool = vi.fn(async () => "yes" as const);
  const conversation = new ConversationState();
  conversation.addUserMessage("write");
  const events: AgentEvent[] = [];
  for await (const event of runAgentLoop({
    provider, conversation, toolRegistry: registry, model: "m", confirmTool, permissionMode,
    iterationsBudget: { remaining: 3, total: 3 },
  })) events.push(event);
  const request = events.find((event) => event.type === "tool_confirmation_request");
  return { confirmTool, execute, request };
}

describe("workspace warning in tool confirmation", () => {
  let cwd: string;
  let outside: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await realpath(await mkdtemp(join(tmpdir(), "agav-ws-warning-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "agav-ws-outside-")));
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it.each(["write_file", "edit_file", "edit_notebook"])("attaches a warning for %s targets outside the project", async (toolName) => {
    const target = join(outside, "nested", "file.txt");
    const { confirmTool, execute, request } = await runWrite(toolName, { path: target, content: "x" });
    const warning = `Target is outside the project: ${target}`;
    expect(request).toMatchObject({ type: "tool_confirmation_request", toolName, warning });
    expect(confirmTool).toHaveBeenCalledTimes(1);
    expect(confirmTool.mock.calls[0]).toEqual([toolName, { path: target, content: "x" }, undefined, undefined, warning]);
    // Warn-only: approval still runs the tool.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("flags `..` traversal out of the project", async () => {
    const { request } = await runWrite("write_file", { path: "../escape.txt", content: "x" });
    expect((request as { warning?: string }).warning).toContain("Target is outside the project:");
  });

  it("omits the warning for targets inside the project and keeps the 4-argument confirm call", async () => {
    const { confirmTool, request } = await runWrite("write_file", { path: "src/new.txt", content: "x" });
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("warning");
    expect(confirmTool.mock.calls[0]).toHaveLength(4);
  });

  it("does not warn for non-write tools", async () => {
    const { request } = await runWrite("run_command", { command: "true", path: join(outside, "x") });
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("warning");
  });

  it("does not change auto-accept behaviour", async () => {
    const { confirmTool, execute, request } = await runWrite("write_file", { path: join(outside, "a.txt"), content: "x" }, "auto-accept");
    expect(request).toBeUndefined();
    expect(confirmTool).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("ToolConfirm warning line", () => {
  type FakeStdout = NodeJS.WriteStream & { chunks: string[] };
  const makeStdout = (): FakeStdout => {
    const emitter = new EventEmitter() as unknown as FakeStdout;
    emitter.chunks = [];
    emitter.isTTY = true;
    emitter.columns = 120;
    emitter.rows = 20;
    emitter.write = ((data: string) => {
      emitter.chunks.push(data);
      return true;
    }) as FakeStdout["write"];
    return emitter;
  };
  const makeStdin = (): NodeJS.ReadStream => {
    const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
    emitter.isTTY = true;
    emitter.setRawMode = (() => emitter) as NodeJS.ReadStream["setRawMode"];
    emitter.resume = (() => emitter) as NodeJS.ReadStream["resume"];
    emitter.pause = (() => emitter) as NodeJS.ReadStream["pause"];
    emitter.read = (() => null) as NodeJS.ReadStream["read"];
    return emitter;
  };
  const stripAnsi = (s: string) => s.replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, "");

  async function renderConfirm(toolName: string, path: string, warning?: string): Promise<string> {
    const stdout = makeStdout();
    const instance = render(h(ToolConfirm, {
      toolName, input: { path }, onConfirm: () => {},
      keybindings: DEFAULT_KEYBINDINGS, warning,
    }), { stdout, stdin: makeStdin(), patchConsole: false, exitOnCtrlC: false });
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await instance.waitUntilRenderFlush();
    }
    instance.unmount();
    return stripAnsi(stdout.chunks.join(""));
  }

  it("renders the provided warning line", async () => {
    const frame = await renderConfirm("write_file", "x.txt", "Target is outside the project: /elsewhere/file.txt");
    expect(frame).toContain("⚠ Target is outside the project: /elsewhere/file.txt");
  });

  it("computes the warning itself for an outside write target when none is passed", async () => {
    const outsideTarget = join(tmpdir(), "agav-ws-confirm-outside", "file.txt");
    const frame = await renderConfirm("edit_file", outsideTarget);
    expect(frame).toContain("⚠ Target is outside the project:");
  });

  it("renders no warning line for inside targets or non-write tools", async () => {
    const inside = await renderConfirm("write_file", join(process.cwd(), "inside.txt"));
    expect(inside).not.toContain("⚠");
    expect(inside).toContain("[Y]es");
    const nonWrite = await renderConfirm("run_command", join(tmpdir(), "elsewhere"));
    expect(nonWrite).not.toContain("⚠");
  });
});
