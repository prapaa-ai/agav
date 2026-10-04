import { describe, expect, it } from "vitest";
import { executeNativeAgent } from "../agents/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentDefinition } from "../agents/types.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";

/**
 * Emits one tool call per requested name, then a final text turn.
 *
 * The executor wraps each agent tool with a context carrying the workflow
 * idempotency key and abort signal, so this drives exactly that path.
 */
class ToolCallingProvider implements LLMProvider {
  name = "tool-calling";
  private turn = 0;

  constructor(private readonly toolNames: string[]) {}

  stream(_params: StreamParams): AsyncIterable<StreamEvent> {
    const turn = this.turn++;
    const names = turn === 0 ? this.toolNames : [];
    return (async function* () {
      for (const [index, name] of names.entries()) {
        const id = `call_${index}`;
        yield { type: "tool_call_start" as const, toolCallId: id, toolName: name };
        yield { type: "tool_call_delta" as const, toolCallId: id, argsJson: "{}" };
        yield { type: "tool_call_end" as const, toolCallId: id };
      }
      yield { type: "text_delta" as const, text: "done" };
      yield { type: "message_end" as const, stopReason: "end_turn" };
    })();
  }
}

const config = {
  provider: "openai",
  model: "mock",
  effort: "low",
  maxTokens: 100,
  maxIterations: 5,
  errorRetries: 0,
  permissionMode: "ask",
  systemPrompt: "",
} as unknown as AgavConfig;

function agentWith(tools: ToolDefinition[]): AgentDefinition {
  return {
    manifest: { name: "ctx-agent", description: "ctx-agent", version: "1.0.0", type: "native" },
    systemPrompt: "call the tools",
    tools,
    origin: "project",
    path: process.cwd(),
  };
}

describe("agents/executor tool context", () => {
  it("scopes idempotency keys per tool and forwards the run signal", async () => {
    const seen: Array<{ name: string; key?: string; aborted?: boolean }> = [];
    const registry = new ToolRegistry();

    for (const name of ["overview", "lsp_query"]) {
      registry.register({
        schema: { name, description: name, inputSchema: { type: "object" }, destructive: false },
        execute: async (_input, context) => {
          seen.push({ name, key: context?.idempotencyKey, aborted: context?.signal?.aborted });
          return { output: name, isError: false };
        },
      });
    }

    const controller = new AbortController();
    await executeNativeAgent(agentWith(registry.list()), "go", {
      provider: new ToolCallingProvider(["overview", "lsp_query"]),
      config,
      idempotencyKey: "run1:node1",
      signal: controller.signal,
    });

    const alpha = seen.find((entry) => entry.name === "overview");
    const beta = seen.find((entry) => entry.name === "lsp_query");

    // Each tool gets a distinct key, so two different calls cannot be mistaken
    // for duplicates of one another.
    expect(alpha?.key).toBe("run1:node1:overview");
    expect(beta?.key).toBe("run1:node1:lsp_query");

    // The run signal reaches agent tools, so a cancelled workflow can stop them.
    expect(alpha?.aborted).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("omits the idempotency key outside workflow execution", async () => {
    const seen: Array<string | undefined> = [];
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: "overview", description: "overview", inputSchema: { type: "object" } },
      execute: async (_input, context) => {
        seen.push(context?.idempotencyKey);
        return { output: "ok", isError: false };
      },
    });

    await executeNativeAgent(agentWith(registry.list()), "go", {
      provider: new ToolCallingProvider(["overview"]),
      config,
    });

    // No workflow key supplied: the tool sees undefined, not a fabricated value.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });
});
