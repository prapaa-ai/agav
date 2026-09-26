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
import { stat, readFile, cp, mkdir, readdir } from "node:fs/promises";
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
  describe("GitHub tree URL branch parsing", () => {
    it("resolves branch names with slashes using ls-remote", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const gitArgs = args[1];
        const cb = args[args.length - 1];
        if (gitArgs && gitArgs[0] === "ls-remote") {
          cb(null, "hash123\trefs/heads/feature/new-agent\nhash456\trefs/heads/main\n", "");
        } else {
          cb(null, "", "");
        }
        return undefined as any;
      });

      // We just want to check the git clone calls, so mock the extraction parts
      vi.mocked(readdir).mockResolvedValue(["AGENT.md"] as any);
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
      // To prevent cleanup failure from failing the test
      vi.mocked(loadAgent).mockResolvedValue({ manifest: { name: "test", version: "1" }, tools: [] } as any);

      await installAgent("https://github.com/owner/repo/tree/feature/new-agent/custom/dir");

      // Verify git clone was called with correct branch
      expect(vi.mocked(execFile)).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["clone", "--branch", "feature/new-agent", "https://github.com/owner/repo"]),
        expect.anything(),
        expect.anything()
      );

      // Verify sparse-checkout was called with correct path
      expect(vi.mocked(execFile)).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["sparse-checkout", "set", "custom/dir"]),
        expect.anything(),
        expect.anything()
      );
    });

    it("rejects ambiguous URLs if branch cannot be resolved from remote refs", async () => {
      vi.mocked(execFile).mockImplementation((...args: any[]) => {
        const gitArgs = args[1];
        const cb = args[args.length - 1];
        if (gitArgs && gitArgs[0] === "ls-remote") {
          cb(null, "hash123\trefs/heads/main\n", ""); // remote only has 'main'
        } else {
          cb(null, "", "");
        }
        return undefined as any;
      });

      const result = await installAgent("https://github.com/owner/repo/tree/feature/new-agent/custom/dir");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Ambiguous or invalid URL: could not resolve branch/tag");
    });
  });
  });
});
