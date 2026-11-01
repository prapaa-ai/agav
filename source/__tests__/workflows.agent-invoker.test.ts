import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agents/types.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";

const executor = vi.hoisted(() => ({ executeNativeAgent: vi.fn(), executeA2AAgent: vi.fn() }));
vi.mock("../agents/executor.js", () => executor);

const { adaptConfirmTool, createDefaultAgentInvoker, PROMPT_AGENT_NAME } = await import("../workflows/agent-invoker.js");

const provider = {} as LLMProvider;
const config = { model: "session-model", maxIterations: 40 } as AgavConfig;
const agent = (overrides: Partial<AgentDefinition["manifest"]> = {}): AgentDefinition => ({
  manifest: { name: "rev", description: "d", version: "1", "native-tools": ["read_file", "grep_search"], ...overrides },
  systemPrompt: "You review.", tools: [], origin: "project", path: "/tmp/agents/rev",
});
const base = { signal: new AbortController().signal, confirmTool: async () => true, cwd: "/tmp" };

beforeEach(() => {
  executor.executeNativeAgent.mockReset().mockResolvedValue("native out");
  executor.executeA2AAgent.mockReset().mockResolvedValue("a2a out");
});

describe("createDefaultAgentInvoker", () => {
  it("dispatches native agents with exactly req.task and per-node overrides, without mutating the agent", async () => {
    const def = agent({ model: "manifest-model" });
    const res = await createDefaultAgentInvoker({ provider, config }).invoke({ ...base, agent: def, task: "Review X", model: "node-model", effort: "high", maxIterations: 5, allowedTools: ["read_file"] });
    expect(res.text).toBe("native out");
    expect(res.model).toBe("node-model");
    expect(typeof res.durationMs).toBe("number");
    expect(executor.executeNativeAgent).toHaveBeenCalledTimes(1);
    const [passed, task, opts] = executor.executeNativeAgent.mock.calls[0]!;
    expect(task).toBe("Review X");
    expect(passed.manifest).toMatchObject({ model: "node-model", effort: "high", "native-tools": ["read_file"] });
    expect(opts).toMatchObject({ provider, config, signal: base.signal, permissionMode: "ask", iterationsBudget: { remaining: 5, total: 5 } });
    expect(def.manifest.model).toBe("manifest-model");
    expect(def.manifest["native-tools"]).toEqual(["read_file", "grep_search"]);
    expect(executor.executeA2AAgent).not.toHaveBeenCalled();
  });

  it("defaults the iteration budget to config and keeps the manifest model", async () => {
    const res = await createDefaultAgentInvoker({ provider, config }).invoke({ ...base, agent: agent({ model: "m" }), task: "t" });
    expect(res.model).toBe("m");
    expect(executor.executeNativeAgent.mock.calls[0]![2].iterationsBudget).toEqual({ remaining: 40, total: 40 });
  });

  it("builds a synthetic prompt agent from systemPrompt and allowedTools", async () => {
    const res = await createDefaultAgentInvoker({ provider, config }).invoke({ ...base, systemPrompt: "Summarize.", allowedTools: ["read_file"], task: "Do it" });
    const [passed, task] = executor.executeNativeAgent.mock.calls[0]!;
    expect(task).toBe("Do it");
    expect(passed.systemPrompt).toBe("Summarize.");
    expect(passed.manifest).toMatchObject({ name: PROMPT_AGENT_NAME, type: "native", "native-tools": ["read_file"] });
    expect(res.model).toBe("session-model");
  });

  it("requires an agent or a systemPrompt and rejects invalid effort", async () => {
    const invoker = createDefaultAgentInvoker({ provider, config });
    await expect(invoker.invoke({ ...base, task: "t" })).rejects.toThrow(/agent or a systemPrompt/);
    await expect(invoker.invoke({ ...base, agent: agent(), task: "t", effort: "extreme" })).rejects.toThrow(/Invalid effort/);
    expect(executor.executeNativeAgent).not.toHaveBeenCalled();
  });

  it("dispatches a2a agents with exactly req.task", async () => {
    const res = await createDefaultAgentInvoker({ provider, config }).invoke({ ...base, agent: agent({ type: "a2a" }), task: "Remote task" });
    expect(res.text).toBe("a2a out");
    expect(executor.executeA2AAgent).toHaveBeenCalledWith(expect.objectContaining({ path: "/tmp/agents/rev" }), "Remote task");
    expect(executor.executeNativeAgent).not.toHaveBeenCalled();
  });

  it("rejects an a2a call when the signal aborts while it is still pending", async () => {
    executor.executeA2AAgent.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = createDefaultAgentInvoker({ provider, config }).invoke({ ...base, signal: controller.signal, agent: agent({ type: "a2a" }), task: "t" });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("does not start any agent when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(createDefaultAgentInvoker({ provider, config }).invoke({ ...base, signal: controller.signal, agent: agent({ type: "a2a" }), task: "t" })).rejects.toThrow("cancelled");
    expect(executor.executeA2AAgent).not.toHaveBeenCalled();
  });

  it("adapts the boolean confirmTool into the executor's ConfirmResult", async () => {
    const confirm = vi.fn(async (name: string) => name === "read_file");
    await createDefaultAgentInvoker({ provider, config }).invoke({ ...base, confirmTool: confirm, agent: agent(), task: "t" });
    const adapted = executor.executeNativeAgent.mock.calls[0]![2].confirmTool;
    await expect(adapted("read_file", { path: "a" })).resolves.toBe("yes");
    await expect(adapted("write_file", { path: "b" })).resolves.toBe("no");
    expect(confirm).toHaveBeenCalledWith("read_file", { path: "a" });
  });
});

describe("adaptConfirmTool", () => {
  it("never returns always", async () => {
    await expect(adaptConfirmTool(async () => true)("x", {})).resolves.toBe("yes");
    await expect(adaptConfirmTool(async () => false)("x", {})).resolves.toBe("no");
  });
});
