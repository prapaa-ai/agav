import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));

vi.mock("../agents/loader.js", () => ({
  loadAgent: vi.fn().mockResolvedValue(null),
}));

vi.mock("../agents/agent-registry.js", () => ({
  registerAgent: vi.fn().mockResolvedValue(undefined),
  isAgentRegistered: vi.fn().mockResolvedValue(false),
  loadRegistry: vi.fn().mockResolvedValue({ agents: {} }),
  saveRegistry: vi.fn().mockResolvedValue(undefined),
}));

import { execFile } from "node:child_process";
import { stat, readFile, cp, mkdir } from "node:fs/promises";
import { registerAgent } from "../agents/agent-registry.js";
import { loadAgent } from "../agents/loader.js";
import { installAgent, uninstallAgent } from "../agents/installer.js";

describe("agents/installer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("subPath traversal in sparse-checkout URLs", () => {
    it("rejects URLs with ../ path traversal in the subdirectory portion", async () => {
      // Mock execFile so git clone "succeeds"
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === "function") cb(null, "", "");
        return undefined as any;
      });

      // URL passes host allowlist but has traversal in the path
      const result = await installAgent(
        "https://github.com/owner/repo/agents/../../../../etc/passwd"
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes");
    });
  });

  describe("validateAgentName (via alias)", () => {
    it("rejects path traversal in alias", async () => {
      const result = await installAgent("/some/local/path", {
        alias: "../../../etc/passwd",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid agent name");
    });

    it("rejects shell metacharacters in alias", async () => {
      const result = await installAgent("/some/local/path", {
        alias: "$(rm -rf /)",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid agent name");
    });

    it("rejects absolute path as alias", async () => {
      const result = await installAgent("/some/local/path", {
        alias: "/etc/passwd",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid agent name");
    });

    it("rejects empty alias", async () => {
      const result = await installAgent("/some/local/path", {
        alias: "",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid agent name");
    });

    it("rejects names with spaces", async () => {
      const result = await installAgent("/some/local/path", {
        alias: "my agent",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid agent name");
    });
  });

  describe("validateGitUrl", () => {
    it("rejects non-allowlisted hosts", async () => {
      const result = await installAgent("https://evil.com/owner/repo");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Untrusted git host");
    });

    it("rejects command injection in URL", async () => {
      const result = await installAgent("https://evil.com/$(whoami)/repo");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Untrusted git host");
    });
  });

  describe("sourceUrl tracking", () => {
    const fakeAgent = {
      manifest: { name: "test-agent", version: "1.0.0", description: "test" },
      systemPrompt: "test",
      tools: [],
      origin: "global" as const,
      path: "/tmp/test-agent",
    };

    beforeEach(() => {
      vi.mocked(loadAgent).mockResolvedValue(fakeAgent as any);
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
    });

    it("sets sourceUrl for file:// marketplace installs", async () => {
      const result = await installAgent("file:///C:/marketplace/agents/test-agent");
      expect(result.success).toBe(true);
      expect(vi.mocked(registerAgent)).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceUrl: "file:///C:/marketplace/agents/test-agent",
        }),
      );
    });

    it("does not set sourceUrl for local path installs", async () => {
      const result = await installAgent("/local/path/test-agent");
      expect(result.success).toBe(true);
      expect(vi.mocked(registerAgent)).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceUrl: undefined,
        }),
      );
    });
  });

  describe("uninstallAgent", () => {
    it("rejects path traversal names", async () => {
      const result = await uninstallAgent("../../etc");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid agent name");
    });

    it("rejects shell metacharacters", async () => {
      const result = await uninstallAgent("foo;rm -rf /");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid agent name");
    });
  });
});
