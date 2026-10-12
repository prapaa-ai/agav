import { EventEmitter } from "node:events";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { useAgent } from "../hooks/use-agent.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";

const skill = {
  name: "Demo", slug: "demo", description: "demo task", body: "Use $ARGUMENTS",
  frontmatter: { name: "Demo", description: "demo task", model: "skill-model", effort: "high" },
  origin: "project", filePath: "/tmp/demo/SKILL.md",
};
vi.mock("../config/history.js", () => ({ saveSession: vi.fn(async () => "session") }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [skill], getCachedSkills: () => [skill], getSkill: () => skill }));
vi.mock("../skills/improvement.js", () => ({ recordSkillTrace: vi.fn(async () => {}), maybeRunBackgroundImprovement: vi.fn(async () => {}) }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "stable project instructions", refreshVolatileContext: async () => ({ context: "volatile git context" }), formatTurnContext: (text: string) => text }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => true, savePlan: vi.fn(), loadPlan: async () => null, clearPlan: vi.fn(), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));

import { saveSession } from "../config/history.js";

async function harness(provider: LLMProvider) {
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  let agent: ReturnType<typeof useAgent>;
  function App() {
    agent = useAgent(provider, { provider: "anthropic", model: "parent-model", effort: "low", maxTokens: 1000, maxIterations: 5, errorRetries: 1, permissionMode: "ask", systemPrompt: "base" });
    return null;
  }
  const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(agent!.skillCommands.length).toBe(1));
  return { instance, getAgent: () => agent! };
}

describe("explicit skill turn lifecycle", () => {
  it.each(["success", "failure", "cancel"] as const)("skips routing and preserves context, gating, history and usage: %s", async (outcome) => {
    vi.mocked(saveSession).mockClear();
    const requests: StreamParams[] = [];
    const provider: LLMProvider = { name: "mock", stream: async function* (params) {
      if (params.signal?.aborted) throw new Error("Aborted");
      requests.push({ ...params, messages: structuredClone(params.messages) });
      if (requests.length === 1) {
        yield { type: "usage", inputTokens: 2, outputTokens: 3 };
        if (outcome === "failure") {
          yield { type: "error", error: new Error("child failed") };
          return;
        }
        yield { type: "tool_call_start", toolCallId: "write-1", toolName: "write_file" };
        yield { type: "tool_call_delta", toolCallId: "write-1", argsJson: '{"path":"demo","content":"test"}' };
        if (outcome === "cancel") {
          yield { type: "tool_call_start", toolCallId: "write-2", toolName: "write_file" };
          yield { type: "tool_call_delta", toolCallId: "write-2", argsJson: '{"path":"second","content":"test"}' };
        }
        yield { type: "message_end", stopReason: "tool_calls" };
      } else {
        yield { type: "usage", inputTokens: 1, outputTokens: 1 };
        yield { type: "text_delta", text: requests.length === 2 && outcome === "success" ? "skill done" : "parent done" };
        yield { type: "message_end", stopReason: "end_turn" };
      }
    } };
    const { instance, getAgent } = await harness(provider);
    const write = vi.fn(async () => ({ output: "written", isError: false }));
    try {
      getAgent().toolRegistry.register({ schema: { name: "write_file", description: "write", destructive: true, inputSchema: { type: "object", properties: {} } }, execute: write });
      getAgent().conversation.addUserMessage("prior relevant discussion");
      const command = await getAgent().skillCommands[0]!.execute("exact args", {} as any);
      expect(command).toEqual({ type: "skill_invoke", skillName: "Demo", arguments: "exact args" });
      expect(await getAgent().submit("/demo exact args", undefined, undefined, undefined, { source: "schedule", detail: "explicit skill" }, { name: "Demo", arguments: "exact args" })).toBe(true);
      if (outcome !== "failure") {
        await vi.waitFor(() => expect(getAgent().pendingConfirmation?.toolName).toBe("write_file"));
        expect(write).not.toHaveBeenCalled();
        if (outcome === "cancel") getAgent().cancel();
        else getAgent().confirmTool("no");
      }
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
      await vi.waitFor(() => expect(getAgent().isLoading).toBe(false));
      expect(write).not.toHaveBeenCalled();
      expect(requests[0]!.model).toBe("skill-model");
      expect(requests[0]!.effort).toBe("high");
      expect(requests[0]!.systemPrompt).toContain("stable project instructions");
      expect(JSON.stringify(requests[0]!.messages)).toContain("prior relevant discussion");
      expect(JSON.stringify(requests[0]!.messages)).toContain("volatile git context");
      expect(JSON.stringify(requests[0]!.messages)).toContain("Use exact args");
      expect(JSON.stringify(requests[0]!.messages)).not.toContain("[skill:");
      expect(getAgent().tokenUsage).toEqual({ inputTokens: outcome === "success" ? 4 : outcome === "failure" ? 3 : 2, outputTokens: outcome === "success" ? 5 : outcome === "failure" ? 4 : 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
      expect(getAgent().conversation.getMessages()[1]).toMatchObject({ sourceText: "/demo exact args", invocationReason: { source: "schedule", detail: "explicit skill" } });
      const result = getAgent().conversation.getMessages().flatMap(m => m.content).find(b => b.type === "tool_result" && b.toolCallId?.startsWith("skill-"));
      expect(result).toMatchObject({ isError: outcome !== "success" });
      if (outcome === "failure") expect(result?.toolResult).toContain("child failed");
      if (outcome !== "cancel") {
        expect(requests.at(-1)!.model).toBe("parent-model");
        expect(saveSession).toHaveBeenCalled();
      } else {
        expect(requests).toHaveLength(1);
        expect(getAgent().pendingConfirmation).toBeNull();
        const progress = getAgent().subagentStates.find(state => state.title === "Skill: Demo");
        expect(progress?.status).toBe("error");
        expect(progress?.toolCalls).toHaveLength(2);
        expect(progress?.toolCalls.every(call => call.status === "error" && call.result === "Tool cancelled.")).toBe(true);
        expect(getAgent().messages.filter(m => m.isError && m.role === "system")).toEqual([]);
        expect(result?.toolResult).toContain("Aborted");
        expect(saveSession).toHaveBeenCalled();
        expect(vi.mocked(saveSession).mock.calls.at(-1)![4]).toEqual(getAgent().tokenUsage);
      }
    } finally {
      instance.unmount();
    }
  });
});
