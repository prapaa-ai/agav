import { describe, it, expect, beforeEach, vi } from "vitest";

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

  it("delegates /login to runLoginCommand with parsed args and suspends the terminal", async () => {
    runLoginMock.mockResolvedValue(0);
    const resume = vi.fn();
    const context = createContext(resume);

    const result = await loginCommand.execute("--oidc --control-plane https://cp", context);

    expect(runLoginMock).toHaveBeenCalledWith("login", ["--oidc", "--control-plane", "https://cp"]);
    expect(context.suspendTerminal).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("message");
    expect((result as any).text.toLowerCase()).toContain("signed in");
  });

  it("passes no args to runLoginCommand when /login is bare", async () => {
    runLoginMock.mockResolvedValue(0);

    await loginCommand.execute("   ", createContext());

    expect(runLoginMock).toHaveBeenCalledWith("login", []);
  });

  it("reports a sign-in failure when runLoginCommand returns non-zero", async () => {
    runLoginMock.mockResolvedValue(1);

    const result = await loginCommand.execute("", createContext());

    expect((result as any).text.toLowerCase()).toContain("failed");
  });

  it("resumes the terminal even when runLoginCommand throws", async () => {
    runLoginMock.mockRejectedValue(new Error("boom"));
    const resume = vi.fn();
    const context = createContext(resume);

    await expect(loginCommand.execute("", context)).rejects.toThrow("boom");
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("delegates /logout to runLoginCommand", async () => {
    runLoginMock.mockResolvedValue(0);

    const result = await logoutCommand.execute("", createContext());

    expect(runLoginMock).toHaveBeenCalledWith("logout", []);
    expect((result as any).text.toLowerCase()).toContain("signed out");
  });

  it("reports a sign-out failure when runLoginCommand returns non-zero", async () => {
    runLoginMock.mockResolvedValue(1);

    const result = await logoutCommand.execute("", createContext());

    expect((result as any).text.toLowerCase()).toContain("failed");
  });
});
