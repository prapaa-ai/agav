import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { main, parseArgs, runPipeMode } from "../main.js";
import { loadConfig } from "../config/config.js";
import { createProvider } from "../providers/registry.js";
import { render } from "../ink/index.js";

vi.mock("../config/config.js", async (original) => ({ ...await original<typeof import("../config/config.js")>(), loadConfig: vi.fn() }));
vi.mock("../config/keybindings.js", () => ({ loadKeybindings: async () => ({}) }));
vi.mock("../config/history.js", () => ({ listSessions: async () => [] }));
vi.mock("../providers/registry.js", () => ({ createProvider: vi.fn() }));
vi.mock("../ink/index.js", () => ({ render: vi.fn(() => ({ waitUntilExit: async () => {} })) }));
vi.mock("../utils/auto-update.js", () => ({ checkAndUpdate: async () => {} }));
vi.mock("../utils/git.js", () => ({ getGitContext: async () => null }));
vi.mock("../utils/terminal-keyboard.js", () => ({ detectKittyKeyboard: async () => false }));
vi.mock("../utils/system-prompt.js", () => ({ refreshDynamicContext: async () => "" }));
vi.mock("../utils/temp-output.js", () => ({ tempOutputManager: { pruneStale: vi.fn() } }));

const config: AgavConfig = { provider: "ollama", model: "mock", systemPrompt: "test", effort: "low", maxTokens: 1000, maxIterations: 5, errorRetries: 0, permissionMode: "auto-accept" };
const originalArgv = process.argv;
const exited = new Error("process exited");
let provider: LLMProvider & { stream: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  provider = { name: "mock", stream: vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: "done" };
    yield { type: "message_end", stopReason: "end_turn" };
  })()) };
  vi.mocked(loadConfig).mockResolvedValue({ ...config });
  vi.mocked(createProvider).mockReturnValue(provider);
  vi.spyOn(process, "exit").mockImplementation(() => { throw exited; });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  // Avoid stdin reads and the interactive non-TTY guard, not the entry paths.
  vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as typeof process.stdin);
  vi.spyOn(process, "on").mockImplementation(() => process);
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); });

async function invoke(args: string[]) {
  process.argv = [process.execPath, "agav", "--provider", "ollama", ...args];
  await expect(main()).rejects.toBe(exited);
}

describe("--max-turns production CLI", () => {
  it.each([{ mode: [] }, { mode: ["-P", "inspect"] }, { mode: ["run", "inspect"] }])("parses both value forms in entry path $mode", ({ mode }) => {
    expect(parseArgs(["--max-turns", "2", ...mode]).maxTurns).toBe(2);
    expect(parseArgs([...mode, "--max-turns=2"]).maxTurns).toBe(2);
  });

  it.each(["0", "-5", "foo"])("rejects %s through main, before entering an agent", async (raw) => {
    await invoke(["--max-turns", raw]);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("--max-turns must be a positive safe integer"));
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it.each(["--max-turns", "--max-turns=2"])("passes the override to interactive rendering: %s", async (flag) => {
    await invoke(flag.includes("=") ? [flag] : [flag, "2"]);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(vi.mocked(render).mock.calls[0]![0]).toHaveProperty("props.config.maxIterations", 2);
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it.each(["-P", "--print", "run"])("runs the real %s loop with an exact cap, retaining no-edit retry allowance", async (mode) => {
    await invoke([mode, "fix the bug", "--max-turns=2"]);
    expect(process.exit).toHaveBeenCalledWith(1); // The retry cannot obtain a third request.
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("maximum iterations"));
    expect(render).not.toHaveBeenCalled();
  });

  it("uses the configured allowance when omitted", async () => {
    await invoke(["run", "fix the bug"]);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(provider.stream).toHaveBeenCalledTimes(4); // Initial request plus three no-edit retries.
  });

  it("gives independent pipe prompts fresh allowances", async () => {
    for (const calls of [1, 2]) {
      expect(await runPipeMode("inspect", { ...config, maxIterations: 1 }, provider, { stdinContent: "" })).toBe(0);
      expect(provider.stream).toHaveBeenCalledTimes(calls);
    }
  });

  it("describes per-prompt limits and counted requests in production help", async () => {
    await invoke(["--help"]);
    const help = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(help).toContain("--max-turns <number>");
    expect(help).toContain("per prompt (interactive, print, and run)");
    expect(help).toContain("agent-loop model requests");
    expect(help).toContain("subagents, native agents, and skills");
    expect(help).toContain("continuations and retries");
    expect(help).not.toContain("agentic turns in a session");
  });
});
