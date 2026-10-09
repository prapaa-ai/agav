import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("/usr/bin/sandbox-exec\n")),
  execFile: vi.fn((_file, _args, _opts, callback) => callback(null, "", "")),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }),
}));
vi.mock("../skills/improvement.js", () => ({ recordSkillTrace: vi.fn(async () => {}) }));
vi.mock("../commands/steer.js", () => ({ formatSteersForPrompt: () => "" }));
vi.mock("../agent/loop.js", () => ({ runAgentLoop: vi.fn() }));
import { spawn } from "node:child_process";
import { runAgentLoop } from "../agent/loop.js";
import { shellTool } from "../tools/shell.js";
import { ToolRegistry } from "../tools/registry.js";
import { executeSkill } from "../skills/executor.js";
import { createSubagentTool } from "../tools/subagent.js";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";

const skill = {
  name: "Policy", slug: "policy", description: "test", body: "Inspect only",
  frontmatter: { name: "Policy", description: "test" }, filePath: "/tmp/SKILL.md", origin: "project" as const,
};
function registry() { const result = new ToolRegistry(); result.register(shellTool); return result; }
const deps = () => ({
  provider: { name: "mock", stream: vi.fn() } as any, parentRegistry: registry(),
  model: "mock", systemPrompt: "", permissionMode: "auto-accept" as const, effort: "medium" as const,
  iterationsBudget: { remaining: 2, total: 2 },
});

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("AGAV_NO_SANDBOX", ""); });
afterEach(() => vi.unstubAllEnvs());

describe("model sandbox policy", () => {
  it.each(["none", "typo", "", null, 42, {}])("rejects tool override %s without launching a process", async (sandbox) => {
    const result = await registry().execute("run_command", { command: "echo harmless", sandbox, allowUnsandboxed: true, inheritEnv: true });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/sandbox/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses the detected backend when override is omitted", async () => {
    expect((await shellTool.execute({ command: "echo harmless" })).isError).toBe(false);
    expect(spawn).toHaveBeenCalledWith("sandbox-exec", expect.any(Array), expect.any(Object));
  });

  it("allows the existing user opt-out, without inheriting secrets", async () => {
    vi.stubEnv("AGAV_NO_SANDBOX", "1"); vi.stubEnv("AGAV_TEST_API_TOKEN", "harmless-secret");
    expect((await shellTool.execute({ command: "echo harmless", sandbox: "none", inheritEnv: true })).isError).toBe(false);
    expect(spawn).toHaveBeenCalledWith("/bin/sh", expect.any(Array), expect.objectContaining({ env: expect.not.objectContaining({ AGAV_TEST_API_TOKEN: "harmless-secret" }) }));
  });

  it("reports an execution override separately from the detected default", async () => {
    const result = await shellTool.execute({ command: "echo harmless", sandbox: "docker" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Shell execution backend: docker");
  });

  it.each(["skill", "subagent"])("enforces policy in inherited %s tools", async (kind) => {
    vi.mocked(runAgentLoop).mockImplementationOnce(({ toolRegistry }) => (async function* () {
      const result = await toolRegistry.execute("run_command", { command: "echo harmless", sandbox: "none" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sandbox bypass denied");
      yield { type: "assistant_message_complete" as const, text: "blocked" };
    })());
    const config = deps();
    if (kind === "skill") await executeSkill(skill, "", config);
    else {
      const tool = createSubagentTool({
        provider: config.provider, parentToolRegistry: config.parentRegistry, getConfig: () => config,
        confirmationQueue: new ConfirmationQueue(), onProgressUpdate: vi.fn(), onTokenUsage: vi.fn(), getSignal: () => undefined,
      });
      expect((await tool.execute({ title: "Policy", task: "Inspect shell policy" })).isError).toBe(false);
    }
    expect(runAgentLoop).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs confirmed skill shell blocks inside the default sandbox with filtered env", async () => {
    vi.stubEnv("AGAV_TEST_API_TOKEN", "harmless-secret");
    vi.mocked(runAgentLoop).mockReturnValueOnce((async function* () {})());
    await executeSkill({ ...skill, body: "```sh\necho harmless\n```" }, "", { ...deps(), permissionMode: "ask", confirmTool: vi.fn(async () => "yes" as const) });
    expect(spawn).toHaveBeenCalledWith("sandbox-exec", expect.any(Array), expect.objectContaining({ env: expect.not.objectContaining({ AGAV_TEST_API_TOKEN: "harmless-secret" }) }));
  });
});
