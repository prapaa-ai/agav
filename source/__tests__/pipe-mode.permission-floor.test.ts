import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";

// Capture the params handed to the agent loop so we can assert the headless
// permission mode is clamped to the org floor (P1: headless print/run must not
// auto-accept below a managed deny-writes/ask policy).
vi.mock("../agent/loop.js", () => ({
  runAgentLoop: vi.fn(() => (async function* () {
    yield { type: "assistant_message_complete" as const, text: "done" };
  })()),
}));

import { runAgentLoop } from "../agent/loop.js";
import { runPipeMode } from "../main.js";

const provider = { name: "mock", stream: vi.fn() } as unknown as LLMProvider;

function makeConfig(overrides: Partial<AgavConfig> = {}): AgavConfig {
  return {
    provider: "anthropic",
    model: "mock-model",
    effort: "low",
    maxTokens: 1024,
    maxIterations: 3,
    errorRetries: 0,
    permissionMode: "auto-accept",
    systemPrompt: "test system prompt",
    ...overrides,
  } as AgavConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("headless permission floor", () => {
  it("clamps the default auto-accept to a managed deny-writes floor", async () => {
    await runPipeMode("do it", makeConfig({ orgPermissionFloor: "deny-writes" }), provider, { stdinContent: "" });
    expect(runAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: "deny-writes",
      permissionFloor: "deny-writes",
    }));
  });

  it("clamps an explicit auto-accept override to the floor", async () => {
    await runPipeMode("do it", makeConfig({ orgPermissionFloor: "ask" }), provider, {
      stdinContent: "",
      permissionOverride: "auto-accept",
    });
    expect(runAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: "ask",
      permissionFloor: "ask",
    }));
  });

  it("leaves the mode unchanged when there is no org floor", async () => {
    await runPipeMode("do it", makeConfig(), provider, { stdinContent: "" });
    expect(runAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: "auto-accept",
      permissionFloor: undefined,
    }));
  });
});
