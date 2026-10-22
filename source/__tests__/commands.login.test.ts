import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../cli/login-cli.js", () => ({
  runLoginCommand: vi.fn(),
}));

import { runLoginCommand } from "../cli/login-cli.js";
import { loginCommand, logoutCommand } from "../commands/login.js";
import type { CommandContext } from "../commands/types.js";

const runLoginMock = vi.mocked(runLoginCommand);

const createContext = (resume = vi.fn()): CommandContext => ({
  conversation: {} as any,
  config: {} as any,
  setModel: vi.fn(),
  setProvider: vi.fn(),
  setEffort: vi.fn(),
  clearMessages: vi.fn(),
  refreshPlan: vi.fn(),
  showStatus: vi.fn(),
  saveSession: vi.fn(),
  refreshDisplay: vi.fn(),
  loadSession: vi.fn(),
  activateSession: vi.fn(),
  renameSession: vi.fn(),
  exit: vi.fn(),
  getDebugState: vi.fn(),
  submit: vi.fn(),
  handleSubmit: vi.fn(),
  toolRegistry: {} as any,
  addTokenUsage: vi.fn(),
  setRunningSkill: vi.fn(),
  setPickerActive: vi.fn(),
  suspendTerminal: vi.fn(() => resume),
  showAgentsTUI: vi.fn(),
  showSkillsTUI: vi.fn(),
});

describe("commands/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // The command temporarily attaches a stdin listener; ensure a crashing test
    // never leaks one into the next.
    expect(process.stdin.listenerCount("data")).toBe(0);
  });

  it("delegates /login with parsed args, suspends the terminal, and passes an abort signal", async () => {
    runLoginMock.mockResolvedValue(0);
    const resume = vi.fn();
    const context = createContext(resume);

    const result = await loginCommand.execute("--oidc --control-plane https://cp", context);

    expect(runLoginMock).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = runLoginMock.mock.calls[0]!;
    expect(cmd).toBe("login");
    expect(argv).toEqual(["--oidc", "--control-plane", "https://cp"]);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(context.suspendTerminal).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("message");
    expect((result as any).text.toLowerCase()).toContain("signed in");
  });

  it("passes no args to runLoginCommand when /login is bare", async () => {
    runLoginMock.mockResolvedValue(0);

    await loginCommand.execute("   ", createContext());

    expect(runLoginMock.mock.calls[0]![0]).toBe("login");
    expect(runLoginMock.mock.calls[0]![1]).toEqual([]);
  });

  it("folds captured console output into the result so it survives the repaint", async () => {
    runLoginMock.mockImplementation(async () => {
      // Simulate the flow writing its outcome to the console while suspended.
      process.stderr.write("unknown argument: --nope\nUsage: /login ...\n");
      return 1;
    });

    const result = await loginCommand.execute("--nope", createContext());

    expect((result as any).text).toContain("unknown argument: --nope");
    expect((result as any).text).toContain("Usage: /login");
    expect((result as any).text.toLowerCase()).toContain("failed");
  });

  it("restores the original stdout/stderr writers after running", async () => {
    const before = process.stdout.write;
    runLoginMock.mockImplementation(async () => {
      expect(process.stdout.write).not.toBe(before); // patched during the flow
      process.stdout.write("hello\n");
      return 0;
    });

    await loginCommand.execute("", createContext());

    expect(process.stdout.write).toBe(before);
  });

  it("reports cancellation when the abort signal fires during the flow", async () => {
    runLoginMock.mockImplementation(async (_cmd, _argv, opts) => {
      // Simulate Ctrl-C arriving on stdin while suspended.
      process.stdin.emit("data", Buffer.from("\x03"));
      expect(opts?.signal?.aborted).toBe(true);
      return 1;
    });

    const result = await loginCommand.execute("--device", createContext());

    expect((result as any).text.toLowerCase()).toContain("cancelled");
  });

  it("does not abort on ordinary keystrokes", async () => {
    runLoginMock.mockImplementation(async (_cmd, _argv, opts) => {
      process.stdin.emit("data", Buffer.from("a"));
      expect(opts?.signal?.aborted).toBe(false);
      return 0;
    });

    const result = await loginCommand.execute("--device", createContext());

    expect((result as any).text.toLowerCase()).toContain("signed in");
  });

  it("resumes the terminal and restores writers even when runLoginCommand throws", async () => {
    const beforeStdout = process.stdout.write;
    runLoginMock.mockRejectedValue(new Error("boom"));
    const resume = vi.fn();
    const context = createContext(resume);

    await expect(loginCommand.execute("", context)).rejects.toThrow("boom");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(process.stdout.write).toBe(beforeStdout);
    expect(process.stdin.listenerCount("data")).toBe(0);
  });

  it("delegates /logout to runLoginCommand", async () => {
    runLoginMock.mockResolvedValue(0);

    const result = await logoutCommand.execute("", createContext());

    expect(runLoginMock.mock.calls[0]![0]).toBe("logout");
    expect(runLoginMock.mock.calls[0]![1]).toEqual([]);
    expect((result as any).text.toLowerCase()).toContain("signed out");
  });

  it("reports a sign-out failure when runLoginCommand returns non-zero", async () => {
    runLoginMock.mockResolvedValue(1);

    const result = await logoutCommand.execute("", createContext());

    expect((result as any).text.toLowerCase()).toContain("failed");
  });
});
