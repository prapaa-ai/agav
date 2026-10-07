import { describe, expect, it, vi } from "vitest";
import { executeSkill } from "../skills/executor.js";

vi.mock("../skills/improvement.js", () => ({ recordSkillTrace: vi.fn(async () => {}) }));
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInSandbox } from "../utils/sandbox.js";
import { shellTool } from "../tools/shell.js";
import { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";

const run = (command: string, timeout = 200, signal?: AbortSignal) => runInSandbox({
  command, cwd: process.cwd(), timeout, maxBuffer: 200_000, forceBackend: "none", signal,
} as Parameters<typeof runInSandbox>[0]);

async function waitForFile(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try { return await readFile(path, "utf8"); } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Child did not start: ${path}`);
}

// Real subprocesses, not mocks: catch open stdin and pipelines retaining pipes.
describe.skipIf(process.platform === "win32")("shell process ownership", () => {
  it("cancels active skill shell blocks and their descendants before child requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-skill-process-test-"));
    const controller = new AbortController();
    const pidFile = join(dir, "pid");
    const stream = vi.fn();
    const onEvent = vi.fn();
    try {
      const command = `/bin/sh -c 'echo \u0024\u0024 > "${pidFile}"; exec sleep 2' | cat`;
      const pending = executeSkill({
        name: "Shell", slug: "shell", description: "shell", body: "```sh\n" + command + "\n```\n```sh\necho second\n```",
        frontmatter: { name: "Shell", description: "shell" }, filePath: join(dir, "SKILL.md"), origin: "project",
      }, "", {
        provider: { name: "mock", stream }, parentRegistry: new ToolRegistry(), model: "mock", systemPrompt: "",
        permissionMode: "auto-accept", effort: "medium", iterationsBudget: { remaining: 2, total: 2 }, signal: controller.signal, onEvent,
      });
      // Attach a rejection handler before aborting to avoid an unhandled promise.
      const rejected = expect(pending).rejects.toThrow("Aborted");
      const pid = Number(await waitForFile(pidFile));
      expect(pid).toBeGreaterThan(0);
      const started = Date.now();
      controller.abort();
      await rejected;
      expect(Date.now() - started).toBeLessThan(1000);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(stream).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenLastCalledWith({ type: "error", error: expect.any(Error) });
    } finally {
      controller.abort();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("inherits credentials for skill shell blocks but filters ordinary commands", async () => {
    vi.stubEnv("AGAV_TEST_API_TOKEN", "harmless-skill-credential");
    const stream = vi.fn(async function* (params) {
      expect(params.messages[0].content[0].text).toBe("harmless-skill-credential");
      yield { type: "text_delta" as const, text: "done" };
    });
    try {
      await executeSkill({
        name: "Shell", slug: "shell", description: "shell",
        body: '```sh\nprintf "%s" "$AGAV_TEST_API_TOKEN"\n```',
        frontmatter: { name: "Shell", description: "shell" }, filePath: "/tmp/SKILL.md", origin: "project",
      }, "", {
        provider: { name: "mock", stream }, parentRegistry: new ToolRegistry(), model: "mock", systemPrompt: "",
        permissionMode: "auto-accept", effort: "medium", iterationsBudget: { remaining: 1, total: 1 },
      });
      expect(stream).toHaveBeenCalledTimes(1);
      const result = await shellTool.execute({ command: 'printf "%s" "${AGAV_TEST_API_TOKEN-unset}"', sandbox: "none" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("unset");
      expect(result.output).not.toContain("harmless-skill-credential");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("closes stdin so a noninteractive read sees EOF", async () => {
    const result = await run("cat; printf done");
    expect(result.error).toBeNull();
    expect(result.stdout).toBe("done");
  });

  it("does not start a command with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run("printf should-not-run", 1000, controller.signal);
    expect(result.error).not.toBeNull();
    expect(result.stdout).toBe("");
  });

  it.each(["timeout", "abort"])("kills pipeline descendants on %s", async (reason) => {
    const dir = await mkdtemp(join(tmpdir(), "agav-process-test-"));
    const controller = new AbortController();
    const pidFile = join(dir, "pid");
    try {
      // Finite fallback lifetime keeps a failing baseline from leaking forever.
      const command = `/bin/sh -c 'echo \u0024\u0024 > "${pidFile}"; exec sleep 2' | cat`;
      const pending = run(command, reason === "timeout" ? 200 : 1000, controller.signal);
      const pid = Number(await waitForFile(pidFile));
      expect(pid).toBeGreaterThan(0);
      if (reason === "abort") controller.abort();
      const result = await pending;
      expect(result.error).not.toBeNull();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns spawn errors instead of hanging", async () => {
    const result = await runInSandbox({ command: "printf done", cwd: "/agav-nonexistent-directory", timeout: 200, maxBuffer: 1024, forceBackend: "none" });
    expect(result.error?.message).toMatch(/ENOENT/);
  });

  it("terminates commands that exceed the output limit", async () => {
    const result = await runInSandbox({ command: "yes", cwd: process.cwd(), timeout: 1000, maxBuffer: 128, forceBackend: "none" });
    expect(result.error?.message).toMatch(/maxBuffer/);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
  });

  it.each([false, true])("preserves late descendant output (streaming: %s)", async (streaming) => {
    const chunks: Buffer[] = [];
    const result = await runInSandbox({
      command: "( sleep 0.4; printf LATE ) & printf EARLY",
      cwd: process.cwd(), timeout: 1500, maxBuffer: 1024, forceBackend: "none",
      onOutput: streaming ? chunk => chunks.push(chunk) : undefined,
    });
    expect(result.error).toBeNull();
    expect(streaming ? Buffer.concat(chunks).toString() : result.stdout).toBe("EARLYLATE");
  });

  it.each([false, true])("preserves redirected background children (streaming: %s)", async (streaming) => {
    const dir = await mkdtemp(join(tmpdir(), "agav-background-test-"));
    const marker = join(dir, "late");
    try {
      const result = await runInSandbox({
        command: `( sleep 0.4; printf survived > '${marker}' ) >/dev/null 2>&1 & printf started`,
        cwd: dir, timeout: 1500, maxBuffer: 1024, forceBackend: "none",
        onOutput: streaming ? () => {} : undefined,
      });
      expect(result.error).toBeNull();
      expect(await waitForFile(marker)).toBe("survived");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("cancels the macOS Seatbelt process group", async () => {
    const controller = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), "agav-seatbelt-process-test-"));
    const marker = join(dir, "started");
    try {
      const pending = runInSandbox({ command: `echo ready > '${marker}'; sleep 2`, cwd: dir, timeout: 1000, maxBuffer: 1024, forceBackend: "seatbelt", signal: controller.signal });
      await waitForFile(marker);
      const started = Date.now();
      controller.abort();
      const result = await pending;
      expect(result.backend).toBe("seatbelt");
      expect(result.error?.message).toMatch(/cancelled/);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      controller.abort();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("retains failed leader status without exposing argv (streaming: %s)", async (streaming) => {
    const result = await runInSandbox({
      command: "sleep 2 & echo /private/secret-path; exit 7",
      cwd: process.cwd(), timeout: 1500, maxBuffer: 1024, forceBackend: "none",
      onOutput: streaming ? () => {} : undefined,
    });
    expect(result.error?.message).toBe("Command exited with code 7");
    expect(result.error?.message).not.toContain("secret-path");
  });

  it("cleans up owned commands when the host exits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-exit-process-test-"));
    const pidFile = join(dir, "pid");
    const sandboxUrl = new URL("../utils/sandbox.ts", import.meta.url).href;
    const script = `
      import { runInSandbox } from ${JSON.stringify(sandboxUrl)};
      import { readFile } from "node:fs/promises";
      void runInSandbox({ command: ${JSON.stringify(`/bin/sh -c 'echo \u0024\u0024 > "${pidFile}"; exec sleep 2' | cat`)}, cwd: process.cwd(), timeout: 1000, maxBuffer: 1024, forceBackend: "none" });
      for (let i = 0; i < 100; i++) {
        try { if ((await readFile(${JSON.stringify(pidFile)}, "utf8")).trim()) process.exit(0); } catch {}
        await new Promise(r => setTimeout(r, 10));
      }
      process.exit(1);
    `;
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 3000 }, error => error ? reject(error) : resolve());
      });
      const pid = Number(await waitForFile(pidFile));
      expect(pid).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the turn signal through the registry to run_command", async () => {
    const controller = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), "agav-loop-process-test-"));
    const marker = join(dir, "started");
    const registry = new ToolRegistry();
    registry.register(shellTool);
    const provider: LLMProvider = {
      name: "mock",
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "tool_call_start", toolCallId: "shell", toolName: "run_command" };
        yield { type: "tool_call_delta", toolCallId: "shell", argsJson: JSON.stringify({ command: `echo ready > '${marker}'; sleep 2`, sandbox: "none" }) };
      },
    };
    const conversation = new ConversationState();
    conversation.addUserMessage("review");
    try {
      const started = Date.now();
      const pending = (async () => {
        for await (const _ of runAgentLoop({ provider, conversation, toolRegistry: registry, model: "mock", permissionMode: "auto-accept", iterationsBudget:{remaining : 1,total :1}, signal: controller.signal })) {}
      })();
      await waitForFile(marker);
      controller.abort();
      await pending;
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      controller.abort();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
