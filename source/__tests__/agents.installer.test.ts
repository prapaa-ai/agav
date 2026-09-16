import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
  writeFile: vi.fn().mockResolvedValue(undefined),
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
import { stat, readFile, cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { registerAgent } from "../agents/agent-registry.js";
import { loadAgent } from "../agents/loader.js";
import { installAgent, uninstallAgent, downloadAgentFiles, MAX_FILE_SIZE } from "../agents/installer.js";

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

    it("rejects non-HTTPS URLs", async () => {
      const result = await installAgent("http://github.com/owner/repo");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Untrusted protocol: http:. Only HTTPS URLs are allowed.");
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

  describe("downloadAgentFiles", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    describe("baseUrl allowlist validation", () => {
      it("rejects non-allowlisted host before fetching", async () => {
        const result = await downloadAgentFiles("https://evil.com/agents/test", ["AGENT.md"]);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Untrusted git host: evil.com");
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it("rejects invalid URL before fetching", async () => {
        const result = await downloadAgentFiles("not-a-valid-url", ["AGENT.md"]);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it("rejects non-HTTPS baseUrl before fetching", async () => {
        const result = await downloadAgentFiles("http://github.com/agents/test", ["AGENT.md"]);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Untrusted protocol: http:. Only HTTPS URLs are allowed.");
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it("allows host from AGAV_ALLOWED_GIT_HOSTS", async () => {
        const origAllowedHosts = process.env.AGAV_ALLOWED_GIT_HOSTS;
        process.env.AGAV_ALLOWED_GIT_HOSTS = "custom.internal.git";
        try {
          fetchSpy.mockResolvedValueOnce(new Response("manifest content", { status: 200 }));
          vi.mocked(readdir).mockResolvedValueOnce(["AGENT.md"] as any);

          const result = await downloadAgentFiles("https://custom.internal.git/agents/test", ["AGENT.md"]);
          expect(result.success).toBe(true);
          expect(fetchSpy).toHaveBeenCalled();
        } finally {
          if (origAllowedHosts !== undefined) {
            process.env.AGAV_ALLOWED_GIT_HOSTS = origAllowedHosts;
          } else {
            delete process.env.AGAV_ALLOWED_GIT_HOSTS;
          }
        }
      });
    });

    describe("maximum response size enforcement", () => {
      it("rejects files when content-length exceeds MAX_FILE_SIZE before reading body", async () => {
        const arrayBufferSpy = vi.fn();
        const cancelSpy = vi.fn().mockResolvedValue(undefined);
        fetchSpy.mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({
            "content-length": String(MAX_FILE_SIZE + 1),
          }),
          body: { cancel: cancelSpy },
          arrayBuffer: arrayBufferSpy,
        });

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("exceeds maximum size limit");
        expect(arrayBufferSpy).not.toHaveBeenCalled();
        expect(cancelSpy).toHaveBeenCalled();
      });

      it("cancels unconsumed response body on non-ok HTTP status", async () => {
        const cancelSpy = vi.fn().mockResolvedValue(undefined);
        fetchSpy.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
          body: { cancel: cancelSpy },
        });

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("404 Not Found");
        expect(cancelSpy).toHaveBeenCalled();
      });

      it("rejects streamed responses when body chunks exceed MAX_FILE_SIZE", async () => {
        const chunk = new Uint8Array(1024 * 1024); // 1MB chunk
        let readCount = 0;
        const customStream = new ReadableStream({
          pull(controller) {
            if (readCount < 6) { // 6MB total
              readCount++;
              controller.enqueue(chunk);
            } else {
              controller.close();
            }
          },
        });

        fetchSpy.mockResolvedValueOnce(new Response(customStream, { status: 200 }));

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("exceeds maximum size limit");
      });

      it("succeeds when files are within MAX_FILE_SIZE limit", async () => {
        fetchSpy.mockResolvedValueOnce(
          new Response("---\nname: test\n---\nPrompt", {
            status: 200,
            headers: { "content-length": "30" },
          }),
        );
        vi.mocked(readdir).mockResolvedValueOnce(["AGENT.md"] as any);

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(true);
        expect(result.path).toBeDefined();
        expect(writeFile).toHaveBeenCalled();
      });
    });

    describe("redirect validation", () => {
      it("follows valid redirects to allowlisted hosts", async () => {
        const cancelSpy = vi.fn().mockResolvedValue(undefined);
        fetchSpy.mockResolvedValueOnce({
          status: 302,
          headers: new Headers({
            location: "https://raw.githubusercontent.com/owner/repo/v1.0.0/agents/test/AGENT.md",
          }),
          body: { cancel: cancelSpy },
        });
        fetchSpy.mockResolvedValueOnce(
          new Response("---\nname: test\n---\nPrompt", {
            status: 200,
            headers: { "content-length": "30" },
          }),
        );
        vi.mocked(readdir).mockResolvedValueOnce(["AGENT.md"] as any);

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(cancelSpy).toHaveBeenCalled();
      });

      it("rejects redirect to untrusted host", async () => {
        fetchSpy.mockResolvedValueOnce({
          status: 302,
          headers: new Headers({
            location: "https://evil.com/agents/test/AGENT.md",
          }),
        });

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Untrusted git host: evil.com");
      });

      it("rejects redirect to non-HTTPS protocol", async () => {
        fetchSpy.mockResolvedValueOnce({
          status: 301,
          headers: new Headers({
            location: "http://raw.githubusercontent.com/owner/repo/main/agents/test/AGENT.md",
          }),
        });

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Untrusted protocol: http:. Only HTTPS URLs are allowed.");
      });

      it("rejects redirect chain exceeding 5 redirects", async () => {
        for (let i = 1; i <= 6; i++) {
          fetchSpy.mockResolvedValueOnce({
            status: 302,
            headers: new Headers({
              location: `https://raw.githubusercontent.com/step${i}/AGENT.md`,
            }),
          });
        }

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Too many redirects (exceeded 5)");
      });

      it("rejects redirect missing Location header", async () => {
        fetchSpy.mockResolvedValueOnce({
          status: 302,
          headers: new Headers({}),
        });

        const result = await downloadAgentFiles(
          "https://raw.githubusercontent.com/owner/repo/main/agents/test",
          ["AGENT.md"],
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("Redirect response missing Location header");
      });
    });
  });
});
