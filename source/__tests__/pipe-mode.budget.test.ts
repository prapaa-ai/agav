import { describe, it, expect, vi, afterEach } from "vitest";
import { runPipeMode } from "../main.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConfig(maxIterations: number): AgavConfig {
  return {
    provider: "anthropic",
    model: "mock-model",
    effort: "low",
    maxTokens: 1024,
    maxIterations,
    errorRetries: 0,
    permissionMode: "auto-accept",
    systemPrompt: "test system prompt",
  } as AgavConfig;
}

/** Queue of plain-text assistant replies; counts every provider.stream() call (one per agent request). */
function makeQueueProvider(responses: string[]): { provider: LLMProvider; calls: () => number } {
  let streamCalls = 0;
  const provider = {
    name: "mock",
    stream: async function* (): AsyncGenerator<StreamEvent> {
      streamCalls++;
      const text = responses[Math.min(streamCalls - 1, responses.length - 1)] ?? "";
      if (text) yield { type: "text_delta", text };
      yield { type: "message_end", stopReason: "end_turn" };
    },
  } as unknown as LLMProvider;
  return { provider, calls: () => streamCalls };
}

function captureOutput(): { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  return { stdout: () => out, stderr: () => err };
}

const OK_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as unknown as import("../utils/output-schema.js").OutputSchema;

describe("print-mode iteration budget sharing", () => {
  it("max-turns=1: invalid schema output does not trigger a second provider request", async () => {
    const { provider, calls } = makeQueueProvider(["not json", '{"ok":true}']);
    const captured = captureOutput();

    const exitCode = await runPipeMode("summarize this", makeConfig(1), provider, {
      stdinContent: "",
      outputSchema: OK_SCHEMA,
    });

    expect(exitCode).toBe(1);
    expect(calls()).toBe(1);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("Iteration budget exhausted");
    expect(captured.stderr()).toContain("skipping schema-correction retry");
  });

  it("correction request consumes the existing budget instead of replenishing it", async () => {
    const { provider, calls } = makeQueueProvider(["not json", '{"ok":true}']);
    const captured = captureOutput();

    const exitCode = await runPipeMode("summarize this", makeConfig(2), provider, {
      stdinContent: "",
      outputSchema: OK_SCHEMA,
    });

    expect(exitCode).toBe(0);
    // Original prompt + one schema correction share the allowance of 2.
    expect(calls()).toBe(2);
    expect(captured.stdout().trim()).toBe('{"ok":true}');
    expect(captured.stderr()).toContain("retrying once");
  });

  it("no-edit retries share the same allowance", async () => {
    const { provider, calls } = makeQueueProvider([
      "analysis with no edits",
      "analysis with no edits",
      "analysis with no edits",
      "analysis with no edits",
    ]);
    const captured = captureOutput();

    const exitCode = await runPipeMode("fix the login bug", makeConfig(2), provider, {
      stdinContent: "",
    });

    expect(exitCode).toBe(1);
    // Up to 4 no-edit attempts exist, but the shared budget caps requests at 2.
    expect(calls()).toBe(2);
    expect(captured.stderr()).toContain("Iteration budget exhausted");
    expect(captured.stderr()).toContain("skipping no-edit retry");
    // Failure returns before printing: stderr carries the reason, stdout stays clean.
    expect(captured.stdout()).toBe("");
  });
});
