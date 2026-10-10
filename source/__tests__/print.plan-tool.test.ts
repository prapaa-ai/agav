import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeMode } from "../main.js";
import { createToolRegistry } from "../tools/registry-factory.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";

vi.mock("../utils/system-prompt.js", () => ({ refreshDynamicContext: async () => "fixture context" }));
vi.mock("../agent/planner.js", async original => ({
  ...await original<typeof import("../agent/planner.js")>(),
  loadPlan: vi.fn(), savePlan: vi.fn(), setPlanScope: vi.fn(), updatePlanStep: vi.fn(),
}));
import { loadPlan, savePlan, setPlanScope, updatePlanStep } from "../agent/planner.js";

const config: AgavConfig = { provider: "openai", model: "mock", effort: "high", maxTokens: 1024,
  maxIterations: 3, errorRetries: 0, permissionMode: "auto-accept" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("headless plan-tool availability", () => {
  it.each([false, true])("does not expose update_plan in headless mode (run context: %s)", async includeDynamicContext => {
    const requests: StreamParams[] = [];
    const provider: LLMProvider = { name: "mock", async *stream(params) {
      requests.push(params);
      yield { type: "text_delta", text: "Inspected." };
      yield { type: "message_end", stopReason: "end_turn" };
    } };
    const defaults = createToolRegistry().getSchemas().map(tool => tool.name);
    expect(defaults).toContain("update_plan");
    expect(await runPipeMode("Inspect this repository", config, provider, { stdinContent: "", includeDynamicContext })).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools!.map(tool => tool.name)).toEqual(defaults.filter(name => name !== "update_plan"));
    expect(loadPlan).not.toHaveBeenCalled();
    expect(savePlan).not.toHaveBeenCalled();
    expect(setPlanScope).not.toHaveBeenCalled();
    expect(updatePlanStep).not.toHaveBeenCalled();
    expect(createToolRegistry().getSchemas().map(tool => tool.name)).toEqual(defaults);
  });

  it("does not mutate a session plan if the model nevertheless requests update_plan", async () => {
    let requests = 0;
    const provider: LLMProvider = { name: "mock", async *stream() {
      requests++;
      if (requests === 1) {
        yield { type: "tool_call_start", toolCallId: "plan-call", toolName: "update_plan" };
        yield { type: "tool_call_delta", toolCallId: "plan-call", argsJson: '{"step":1,"status":"done"}' };
        yield { type: "message_end", stopReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "Inspected without a stored plan." };
        yield { type: "message_end", stopReason: "end_turn" };
      }
    } };
    expect(await runPipeMode("Inspect", config, provider, { stdinContent: "" })).toBe(0);
    expect(requests).toBe(2);
    expect(updatePlanStep).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Unknown tool: update_plan"));
  });
});
