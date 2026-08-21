import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn().mockRejectedValue(new Error("ENOENT")),
  stat: vi.fn(),
}));

import { readFile, readdir, stat } from "node:fs/promises";
import { loadAgent } from "../agents/loader.js";

describe("agents/loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: stat succeeds for AGENT.md, readdir fails for tools dir (no tools)
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));
  });

  describe("parseAgentMarkdown (via loadAgent)", () => {
    it("parses nested tool-permissions and mcp-servers", async () => {
      const agentMd = [
        "---",
        "name: test-agent",
        "description: A test agent",
        "version: 1.0.0",
        "tool-permissions:",
        "  run_query: safe",
        "  delete_table: destructive",
        "mcp-servers:",
        "  - key: db-server",
        "    command: npx",
        '    args: ["-y", "@db/mcp"]',
        "---",
        "You are a test agent.",
      ].join("\n");

      vi.mocked(readFile).mockResolvedValue(agentMd);

      const agent = await loadAgent("/fake/agent-dir", "global");

      expect(agent).not.toBeNull();
      expect(agent!.manifest.name).toBe("test-agent");
      expect(agent!.manifest["tool-permissions"]).toEqual({
        run_query: "safe",
        delete_table: "destructive",
      });
      expect(agent!.manifest["mcp-servers"]).toEqual([
        { key: "db-server", command: "npx", args: ["-y", "@db/mcp"] },
      ]);
      expect(agent!.systemPrompt).toBe("You are a test agent.");
    });

    it("parses CRLF line endings", async () => {
      const agentMd = [
        "---",
        "name: crlf-agent",
        "description: CRLF test",
        "version: 0.1.0",
        "---",
        "System prompt body.",
      ].join("\r\n");

      vi.mocked(readFile).mockResolvedValue(agentMd);

      const agent = await loadAgent("/fake/crlf-dir", "global");

      expect(agent).not.toBeNull();
      expect(agent!.manifest.name).toBe("crlf-agent");
      expect(agent!.systemPrompt).toBe("System prompt body.");
    });

    it("returns null on missing frontmatter", async () => {
      vi.mocked(readFile).mockResolvedValue("No frontmatter here.");

      const agent = await loadAgent("/fake/bad-dir", "global");
      expect(agent).toBeNull();
    });

    it("returns null on missing required fields", async () => {
      const agentMd = [
        "---",
        "name: incomplete",
        "---",
        "Body.",
      ].join("\n");

      vi.mocked(readFile).mockResolvedValue(agentMd);

      const agent = await loadAgent("/fake/incomplete-dir", "global");
      expect(agent).toBeNull();
    });

    it("parses required-config as array", async () => {
      const agentMd = [
        "---",
        "name: config-agent",
        "description: Agent with config",
        "version: 1.0.0",
        "required-config:",
        "  - API_KEY",
        "  - API_SECRET",
        "---",
        "Prompt.",
      ].join("\n");

      vi.mocked(readFile).mockResolvedValue(agentMd);

      const agent = await loadAgent("/fake/config-dir", "global");

      expect(agent).not.toBeNull();
      expect(agent!.manifest["required-config"]).toEqual(["API_KEY", "API_SECRET"]);
    });
  });
});
