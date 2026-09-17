import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  stripAnsi,
  filterEnv,
  getShellCommand,
  runPtyCommand,
  createPtySession,
  setMockNodePty,
  resetNodePtyCache,
  isPtySupported,
} from "../tools/pty-shell.js";
import { shellTool } from "../tools/shell.js";

describe("tools/pty-shell", () => {
  beforeEach(() => {
    resetNodePtyCache();
  });

  afterEach(() => {
    resetNodePtyCache();
    vi.restoreAllMocks();
  });

  describe("stripAnsi", () => {
    it("strips ANSI color and control codes correctly", () => {
      const colored = "\u001B[31mError:\u001B[39m \u001B[1mbold text\u001B[22m";
      expect(stripAnsi(colored)).toBe("Error: bold text");
    });

    it("handles plain strings without modification", () => {
      expect(stripAnsi("plain text without ansi")).toBe("plain text without ansi");
    });
  });

  describe("filterEnv", () => {
    it("removes secret-like environment variables while keeping safe variables", () => {
      const originalEnv = { ...process.env };
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
      process.env.OPENAI_API_KEY = "sk-test-openai";
      process.env.AUTH_SECRET = "supersecret";
      process.env.SAFE_TOOL_PATH = "/usr/bin";

      try {
        const filtered = filterEnv({ CUSTOM_VAR: "custom-val" });
        expect(filtered.ANTHROPIC_API_KEY).toBeUndefined();
        expect(filtered.OPENAI_API_KEY).toBeUndefined();
        expect(filtered.AUTH_SECRET).toBeUndefined();
        expect(filtered.SAFE_TOOL_PATH).toBe("/usr/bin");
        expect(filtered.CUSTOM_VAR).toBe("custom-val");
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe("getShellCommand", () => {
    it("returns executable shell command and arguments", () => {
      const cmd = getShellCommand("node -v");
      expect(cmd.shell).toBeTruthy();
      expect(Array.isArray(cmd.args)).toBe(true);
      expect(cmd.args.some((a) => a.includes("node -v") || a === "node -v")).toBe(true);
    });
  });

  describe("runPtyCommand execution", () => {
    it("executes standard node command and returns stdout", async () => {
      const result = await runPtyCommand({
        command: "node -e \"console.log('PTY_SHELL_TEST_SUCCESS')\"",
        timeout: 10_000,
      });

      expect(result.isError).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("PTY_SHELL_TEST_SUCCESS");
      expect(result.timedOut).toBe(false);
    });

    it("captures non-zero exit code on failure", async () => {
      const result = await runPtyCommand({
        command: "node -e \"process.exit(42)\"",
        timeout: 10_000,
      });

      expect(result.isError).toBe(true);
      expect(result.exitCode).toBe(42);
    });

    it("streams output chunks via onStdoutChunk", async () => {
      const chunks: string[] = [];
      const result = await runPtyCommand({
        command: "node -e \"process.stdout.write('chunk1'); process.stdout.write('chunk2');\"",
        timeout: 10_000,
        onStdoutChunk: (chunk) => {
          chunks.push(chunk);
        },
      });

      expect(result.isError).toBe(false);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.join("")).toContain("chunk1chunk2");
    });

    it("forwards stdin to interactive process", async () => {
      const result = await runPtyCommand({
        command: "node -e \"process.stdin.on('data', d => { console.log('REC:' + d.toString().trim()); process.exit(0); });\"",
        stdin: "input_hello_from_pty\n",
        timeout: 10_000,
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("REC:input_hello_from_pty");
    });

    it("enforces timeout on hanging commands", async () => {
      const startTime = Date.now();
      const result = await runPtyCommand({
        command: "node -e \"setTimeout(() => {}, 60000)\"",
        timeout: 400,
      });
      const duration = Date.now() - startTime;

      expect(result.timedOut).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("timed out");
      expect(duration).toBeLessThan(5000);
    });

    it("cancels execution when AbortSignal triggers", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);

      const result = await runPtyCommand({
        command: "node -e \"setTimeout(() => {}, 60000)\"",
        timeout: 10_000,
        signal: controller.signal,
      });

      expect(result.isError).toBe(true);
    });
  });

  describe("sandbox safety guards in pty-shell", () => {
    it("blocks critically dangerous commands unconditionally", async () => {
      const result = await runPtyCommand({
        command: "format C:",
        confirmed: true,
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Blocked:");
      expect(result.output).toContain("matches a critically dangerous command pattern");
    });

    it("blocks unconfirmed destructive commands", async () => {
      const result = await runPtyCommand({
        command: "git clean -fdx",
        confirmed: false,
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("matches a destructive command pattern");
    });

    it("allows destructive commands when explicitly confirmed", async () => {
      // Use dry-run echo so we test execution without deleting files
      const result = await runPtyCommand({
        command: "git clean -fdx -n",
        confirmed: true,
        timeout: 5000,
      });

      expect(result.output).not.toContain("Blocked:");
    });
  });

  describe("mocked PTY session integration", () => {
    it("uses mocked node-pty when registered", async () => {
      let writeCalledWith = "";
      let killedWithSignal = "";

      const mockPtyProcess = {
        pid: 99999,
        write: (d: string) => {
          writeCalledWith = d;
        },
        resize: vi.fn(),
        kill: (sig?: string) => {
          killedWithSignal = sig ?? "SIGTERM";
        },
        onData: (cb: (chunk: string) => void) => {
          setTimeout(() => {
            cb("\u001B[32mMock PTY Output\u001B[0m");
          }, 10);
        },
        onExit: (cb: (ev: { exitCode: number; signal?: string }) => void) => {
          setTimeout(() => {
            cb({ exitCode: 0 });
          }, 30);
        },
      };

      const mockNodePty = {
        spawn: vi.fn(() => mockPtyProcess),
      };

      setMockNodePty(mockNodePty);
      expect(await isPtySupported()).toBe(true);

      const session = await createPtySession({
        command: "test-cmd",
        forceNonPty: false,
      });

      expect(session.isPty).toBe(true);
      expect(session.pid).toBe(99999);

      session.write("hello mock");
      expect(writeCalledWith).toBe("hello mock");

      session.kill("SIGINT");
      expect(killedWithSignal).toBe("SIGINT");
    });
  });

  describe("shellTool interactive integration", () => {
    it("routes to runPtyCommand when interactive is true", async () => {
      const result = await shellTool.execute({
        command: "node -e \"console.log('INTERACTIVE_SHELL_TOOL_OK')\"",
        interactive: true,
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("INTERACTIVE_SHELL_TOOL_OK");
    });

    it("routes to runPtyCommand when context has onStdoutChunk callback", async () => {
      const chunks: string[] = [];
      const result = await shellTool.execute(
        {
          command: "node -e \"console.log('STREAMING_SHELL_TOOL_OK')\"",
        },
        {
          onStdoutChunk: (c) => chunks.push(c),
        },
      );

      expect(result.isError).toBe(false);
      expect(chunks.join("")).toContain("STREAMING_SHELL_TOOL_OK");
    });
  });
});
