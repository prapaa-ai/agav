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

import { installAgent, uninstallAgent } from "../agents/installer.js";

describe("agents/installer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
