import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import * as hooks from "../agent/hooks.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";

async function collect(loop: AsyncIterable<AgentEvent>, onEvent?: (event: AgentEvent) => void) {
  const events: AgentEvent[] = [];
  for await (const event of loop) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

function expectAborted(events: AgentEvent[]) {
  expect(events.at(-1)).toEqual({ type: "error", error: new Error("Aborted") });
  expect(events.some(event => event.type === "turn_complete")).toBe(false);
}

afterEach(() => vi.restoreAllMocks());

describe("agent cancellation boundaries", () => {
  it.each(["stream exhaustion", "assistant completion", "steer event"] as const)(
    "does not complete a no-tool turn cancelled during %s", async (abortAt) => {
      const controller = new AbortController();
      const conversation = new ConversationState();
      conversation.addUserMessage("answer");
      const drainSteers = vi.fn(() => abortAt === "steer event" ? ["pending directive"] : []);
      const provider: LLMProvider = {
        name: "mock",
        stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", text: "answer" };
          yield { type: "message_end", stopReason: "end_turn" };
          if (abortAt === "stream exhaustion") controller.abort();
        }),
      };
      const events = await collect(runAgentLoop({
        provider, conversation, toolRegistry: new ToolRegistry(), model: "mock",
        iterationsBudget: { remaining: 2, total: 2 }, signal: controller.signal, drainSteers,
      }), event => {
        if (abortAt === "assistant completion" && event.type === "assistant_message_complete") controller.abort();
        if (abortAt === "steer event" && event.type === "steer_applied") controller.abort();
      });
      expectAborted(events);
      expect(provider.stream).toHaveBeenCalledTimes(1);
      if (abortAt !== "steer event") expect(drainSteers).not.toHaveBeenCalled();
    },
  );

  it.each(["execution", "result yield", "hook"] as const)(
    "skips remaining hooks and retains every tool pair when cancelled during %s", async (abortAt) => {
      const controller = new AbortController();
      const conversation = new ConversationState();
      conversation.addUserMessage("write files");
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => {
        // Let both parallel calls start before cancellation.
        await Promise.resolve();
        if (abortAt === "execution") controller.abort();
        return { output: "written", isError: false };
      });
      registry.register({
        schema: { name: "write_file", description: "write", inputSchema: { type: "object", properties: {} } },
        execute,
      });
      const runHook = vi.spyOn(hooks, "runHook").mockImplementation(async () => {
        if (abortAt === "hook") controller.abort();
        return null;
      });
      const provider: LLMProvider = {
        name: "mock",
        stream: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
          for (const id of ["one", "two"]) {
            yield { type: "tool_call_start", toolCallId: id, toolName: "write_file" };
            yield { type: "tool_call_delta", toolCallId: id, argsJson: JSON.stringify({ path: id }) };
          }
          yield { type: "message_end", stopReason: "tool_calls" };
        }),
      };
      const drainSteers = vi.fn(() => ["pending directive"]);
      const events = await collect(runAgentLoop({
        provider, conversation, toolRegistry: registry, model: "mock", permissionMode: "auto-accept",
        hooks: { afterEdit: "echo $path" }, iterationsBudget: { remaining: 2, total: 2 },
        signal: controller.signal, drainSteers,
      }), event => {
        if (abortAt === "result yield" && event.type === "tool_result") controller.abort();
      });
      expectAborted(events);
      expect(provider.stream).toHaveBeenCalledTimes(1);
      expect(drainSteers).not.toHaveBeenCalled();
      expect(runHook).toHaveBeenCalledTimes(abortAt === "execution" ? 0 : 1);
      if (abortAt !== "execution") {
        expect(runHook).toHaveBeenCalledWith("echo $path", { path: "one" }, controller.signal);
      }
      const blocks = conversation.getMessages().flatMap(message => message.content);
      const calls = blocks.filter(block => block.type === "tool_use");
      const results = blocks.filter(block => block.type === "tool_result");
      expect(calls.map(block => block.toolCallId)).toEqual(["one", "two"]);
      expect(results.map(block => block.toolCallId)).toEqual(["one", "two"]);
      expect(results.every(block => block.toolResult === "written" && !block.isError)).toBe(true);
      expect(events.filter(event => event.type === "tool_result")).toHaveLength(2);
    },
  );
});

describe("abortable hooks", () => {
  it("preserves trimmed output and null on empty output or command failure", async () => {
    expect(await hooks.runHook("echo $path", { path: "hello" })).toBe("hello");
    expect(await hooks.runHook("exit 0", {})).toBeNull();
    expect(await hooks.runHook("echo ignored; exit 1", {})).toBeNull();
  });

  it("does not start a hook with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await hooks.runHook("echo should-not-run", {}, controller.signal)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("aborts a running hook process without changing null-on-error behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-hook-cancel-"));
    const marker = join(dir, "started");
    const controller = new AbortController();
    // exec replaces the shell, so the process observed here is the hook itself.
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 10000)`;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const pending = hooks.runHook(`exec ${quote(process.execPath)} -e ${quote(script)}`, {}, controller.signal);
    let pid: number | undefined;
    try {
      await vi.waitFor(async () => {
        pid = Number(await readFile(marker, "utf8"));
        expect(pid).toBeGreaterThan(0);
      }, { timeout: 2000, interval: 10 });
      controller.abort();
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Hook did not abort promptly")), 1000);
          void pending.finally(() => clearTimeout(timer));
        }),
      ]);
      expect(result).toBeNull();
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 1000 });
    } finally {
      controller.abort();
      if (pid) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
      await pending;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
