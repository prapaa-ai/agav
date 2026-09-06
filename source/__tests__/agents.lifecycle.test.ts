import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));

vi.mock("../agents/installer.js", () => ({
  uninstallAgent: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../agents/templates.js", () => ({
  saveTemplate: vi.fn().mockResolvedValue(undefined),
}));

import { deleteAgentWithTemplate } from "../agents/agent-lifecycle.js";
import { uninstallAgent } from "../agents/installer.js";
import { saveTemplate } from "../agents/templates.js";
import type { AgentDefinition } from "../agents/types.js";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    manifest: { name: "test-agent", description: "Test", version: "1.0.0" },
    systemPrompt: "You are a test agent.",
    tools: [],
    origin: "global",
    path: "/fake/path",
    ...overrides,
  } as AgentDefinition;
}

describe("agents/agent-lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves template for user-created agents (no sourceUrl)", async () => {
    const agent = makeAgent();
    const result = await deleteAgentWithTemplate(agent);

    expect(result.success).toBe(true);
    expect(result.savedTemplate).toBe(true);
    expect(vi.mocked(saveTemplate)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test-agent",
        description: "Test",
        systemPrompt: "You are a test agent.",
      }),
    );
    expect(vi.mocked(uninstallAgent)).toHaveBeenCalledWith("test-agent", "global");
  });

  it("does NOT save template for marketplace agents (has sourceUrl)", async () => {
    const agent = makeAgent();
    const result = await deleteAgentWithTemplate(agent, {
      sourceUrl: "https://marketplace.example.com/agents/test-agent",
    });

    expect(result.success).toBe(true);
    expect(result.savedTemplate).toBe(false);
    expect(vi.mocked(saveTemplate)).not.toHaveBeenCalled();
    expect(vi.mocked(uninstallAgent)).toHaveBeenCalled();
  });

  it("does NOT save template for file:// marketplace agents", async () => {
    const agent = makeAgent();
    const result = await deleteAgentWithTemplate(agent, {
      sourceUrl: "file:///C:/marketplace/agents/test-agent",
    });

    expect(result.success).toBe(true);
    expect(result.savedTemplate).toBe(false);
    expect(vi.mocked(saveTemplate)).not.toHaveBeenCalled();
  });

  it("does NOT save template for bundled agents", async () => {
    const agent = makeAgent({ origin: "bundled" });
    const result = await deleteAgentWithTemplate(agent);

    expect(result.success).toBe(true);
    expect(result.savedTemplate).toBe(false);
    expect(vi.mocked(saveTemplate)).not.toHaveBeenCalled();
  });

  it("does NOT save template for project agents", async () => {
    const agent = makeAgent({ origin: "project" });
    const result = await deleteAgentWithTemplate(agent);

    expect(result.success).toBe(true);
    expect(result.savedTemplate).toBe(false);
    expect(vi.mocked(saveTemplate)).not.toHaveBeenCalled();
  });

  it("uses alias for uninstall key when present", async () => {
    const agent = makeAgent({ alias: "my-alias" });
    await deleteAgentWithTemplate(agent);

    expect(vi.mocked(uninstallAgent)).toHaveBeenCalledWith("my-alias", "global");
  });

  it("uses 'project' destination for project-origin agents", async () => {
    const agent = makeAgent({ origin: "project" });
    await deleteAgentWithTemplate(agent);

    expect(vi.mocked(uninstallAgent)).toHaveBeenCalledWith("test-agent", "project");
  });

  it("returns error when uninstall fails", async () => {
    vi.mocked(uninstallAgent).mockResolvedValueOnce({ success: false, error: "Not found" });
    const agent = makeAgent();
    const result = await deleteAgentWithTemplate(agent);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Not found");
    expect(result.savedTemplate).toBe(true);
  });

  it("preserves mcp-servers and tags in saved template", async () => {
    const agent = makeAgent({
      manifest: {
        name: "mcp-agent",
        description: "Has MCP",
        version: "1.0.0",
        "mcp-servers": [{ key: "github", command: "npx", args: ["-y", "@mcp/github"] }],
        tags: ["github", "dev"],
      } as any,
      systemPrompt: "MCP prompt",
    });

    await deleteAgentWithTemplate(agent);

    expect(vi.mocked(saveTemplate)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "mcp-agent",
        mcpServers: [{ key: "github", command: "npx", args: ["-y", "@mcp/github"] }],
        tags: ["github", "dev"],
      }),
    );
  });
});
