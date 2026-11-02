import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../cli/login-cli.js", () => ({
  runLoginCommand: vi.fn(),
}));
vi.mock("../account/account-login.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../account/account-login.js")>();
  return { ...original, signOutAccount: vi.fn() };
});

import { runLoginCommand } from "../cli/login-cli.js";
import { loginCommand, logoutCommand } from "../commands/login.js";
import { signOutAccount } from "../account/account-login.js";
import type { CommandContext } from "../commands/types.js";

const runLoginMock = vi.mocked(runLoginCommand);
const signOutMock = vi.mocked(signOutAccount);

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

/** A context whose showLoginTUI immediately drives the wizard to a given outcome. */
const createWizardContext = (
  outcome: { cancelled: boolean; message?: string } | undefined,
): CommandContext => ({
  ...createContext(),
  showLoginTUI: outcome === undefined
    ? undefined
    : vi.fn((onDone: (r: { cancelled: boolean; message?: string }) => void) => onDone(outcome)),
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

  it("delegates /login with parsed args, suspends the terminal, and passes signal + sinks", async () => {
    runLoginMock.mockResolvedValue(0);
    const resume = vi.fn();
    const context = createContext(resume);

    const result = await loginCommand.execute("--oidc --control-plane https://cp", context);

    expect(runLoginMock).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = runLoginMock.mock.calls[0]!;
    expect(cmd).toBe("login");
    expect(argv).toEqual(["--oidc", "--control-plane", "https://cp"]);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof opts?.onMessage).toBe("function");
    expect(typeof opts?.onError).toBe("function");
    expect(context.suspendTerminal).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("message");
  });

  it("passes only the enterprise flags to runLoginCommand", async () => {
    runLoginMock.mockResolvedValue(0);

    await loginCommand.execute("--device", createContext());

    expect(runLoginMock.mock.calls[0]![0]).toBe("login");
    expect(runLoginMock.mock.calls[0]![1]).toEqual(["--device"]);
  });

  it("shows the captured success line verbatim on success", async () => {
    runLoginMock.mockImplementation(async (_cmd, _argv, opts) => {
      opts?.onMessage?.("Signed in as user@example.org. Your organization's settings are now active — restart Agav to use them.");
      return 0;
    });

    const result = await loginCommand.execute("--oidc", createContext());

    expect((result as any).text).toContain("Signed in as user@example.org");
    expect((result as any).text).toContain("restart Agav");
  });

  it("folds captured error detail into the result so it survives the repaint", async () => {
    runLoginMock.mockImplementation(async (_cmd, _argv, opts) => {
      opts?.onError?.("Could not reach the control plane at https://auth.agav.dev: Unable to connect.");
      return 1;
    });

    const result = await loginCommand.execute("--device", createContext());

    expect((result as any).text).toContain("Sign-in failed.");
    expect((result as any).text).toContain("Could not reach the control plane");
  });

  it("reports success, not cancellation, when the abort races a successful enrollment", async () => {
    // Enrollment persists before the success-audit event is awaited; a Ctrl-C in
    // that window aborts the signal but login already succeeded (returns 0).
    runLoginMock.mockImplementation(async (_cmd, _argv, opts) => {
      process.stdin.emit("data", Buffer.from("\x03"));
      expect(opts?.signal?.aborted).toBe(true);
      opts?.onMessage?.("Signed in as user@example.org. ... restart Agav to use them.");
      return 0;
    });

    const result = await loginCommand.execute("--device", createContext());

    expect((result as any).text.toLowerCase()).toContain("signed in");
    expect((result as any).text.toLowerCase()).not.toContain("cancelled");
  });

  it("reports cancellation when Ctrl-C aborts a failing flow", async () => {
    runLoginMock.mockImplementation(async (_cmd, _argv, opts) => {
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

    expect(result.type).toBe("message");
  });

  it("resumes the terminal and removes the stdin listener even when runLoginCommand throws", async () => {
    runLoginMock.mockRejectedValue(new Error("boom"));
    const resume = vi.fn();
    const context = createContext(resume);

    await expect(loginCommand.execute("--device", context)).rejects.toThrow("boom");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(process.stdin.listenerCount("data")).toBe(0);
  });

  it("delegates /logout to runLoginCommand and shows its captured line", async () => {
    runLoginMock.mockImplementation(async (_cmd, _argv, opts) => {
      opts?.onMessage?.("Signed out of your organization. Restart Agav to apply.");
      return 0;
    });

    const result = await logoutCommand.execute("", createContext());

    expect(runLoginMock.mock.calls[0]![0]).toBe("logout");
    expect(runLoginMock.mock.calls[0]![1]).toEqual([]);
    expect((result as any).text.toLowerCase()).toContain("signed out");
  });

  it("reports a sign-out failure with detail when runLoginCommand returns non-zero", async () => {
    runLoginMock.mockImplementation(async (_cmd, _argv, opts) => {
      opts?.onError?.("Could not sign out: the enrollment cache could not be removed (EACCES).");
      return 1;
    });

    const result = await logoutCommand.execute("", createContext());

    expect((result as any).text.toLowerCase()).toContain("failed");
    expect((result as any).text).toContain("EACCES");
  });

  describe("consumer account routing", () => {
    it("bare /login opens the consumer wizard (not enterprise)", async () => {
      const ctx = createWizardContext({ cancelled: false, message: "Signed in to your Agav account as u@x.com. Restart Agav to use it." });
      const result = await loginCommand.execute("", ctx);

      expect(runLoginMock).not.toHaveBeenCalled();
      expect(ctx.showLoginTUI).toHaveBeenCalledTimes(1);
      expect(ctx.setPickerActive).toHaveBeenCalledWith(true);
      expect(ctx.setPickerActive).toHaveBeenCalledWith(false);
      expect((result as any).text.toLowerCase()).toContain("signed in to your agav account");
    });

    it("/login --consumer also opens the wizard", async () => {
      const ctx = createWizardContext({ cancelled: false, message: "Signed in to your Agav account." });
      await loginCommand.execute("--consumer", ctx);
      expect(runLoginMock).not.toHaveBeenCalled();
      expect(ctx.showLoginTUI).toHaveBeenCalledTimes(1);
    });

    it("enterprise flags still route to enterprise enrollment, not the wizard", async () => {
      runLoginMock.mockResolvedValue(0);
      const ctx = createWizardContext({ cancelled: true });
      await loginCommand.execute("--oidc", ctx);
      expect(ctx.showLoginTUI).not.toHaveBeenCalled();
      expect(runLoginMock).toHaveBeenCalledTimes(1);
      expect(runLoginMock.mock.calls[0]![0]).toBe("login");
    });

    it("reports cancellation when the wizard is dismissed", async () => {
      const ctx = createWizardContext({ cancelled: true });
      const result = await loginCommand.execute("", ctx);
      expect((result as any).text.toLowerCase()).toContain("cancelled");
      expect(ctx.setPickerActive).toHaveBeenCalledWith(false);
    });

    it("explains the wizard needs an interactive terminal when unavailable (headless)", async () => {
      const ctx = createWizardContext(undefined); // showLoginTUI absent
      const result = await loginCommand.execute("", ctx);
      expect(runLoginMock).not.toHaveBeenCalled();
      expect((result as any).text.toLowerCase()).toContain("interactive terminal");
    });

    it("rejects a bare key typed on the command line (never accept a key via argv)", async () => {
      const ctx = createWizardContext({ cancelled: true });
      const result = await loginCommand.execute("agav_sk_rawkey123456", ctx);
      expect(ctx.showLoginTUI).not.toHaveBeenCalled();
      expect((result as any).text.toLowerCase()).toContain("shell history");
    });

    it("/logout --account signs out the consumer account (not enterprise)", async () => {
      signOutMock.mockResolvedValue(undefined);
      const result = await logoutCommand.execute("--account", createContext());
      expect(runLoginMock).not.toHaveBeenCalled();
      expect(signOutMock).toHaveBeenCalledTimes(1);
      expect((result as any).text.toLowerCase()).toContain("signed out of your agav account");
    });

    it("bare /logout still routes to enterprise (consumer sign-out needs --account)", async () => {
      runLoginMock.mockResolvedValue(0);
      await logoutCommand.execute("", createContext());
      expect(signOutMock).not.toHaveBeenCalled();
      expect(runLoginMock).toHaveBeenCalledTimes(1);
      expect(runLoginMock.mock.calls[0]![0]).toBe("logout");
    });
  });
});

describe("wizard service routing", () => {
  it("forwards the validated override through the UI boundary", async () => {
    const ctx = createWizardContext({ cancelled: true });
    await loginCommand.execute("--account-service https://staging.example/base", ctx);
    expect(ctx.showLoginTUI).toHaveBeenCalledWith(expect.any(Function), "https://staging.example/base");
  });
  it.each(["http://remote.example", "https://user:password@example.test", "https://example.test/?token=secret"])("rejects unsafe base %s before opening UI", async service => {
    const ctx = createWizardContext({ cancelled: true });
    const result = await loginCommand.execute(`--account-service ${service}`, ctx);
    expect(ctx.showLoginTUI).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "message", text: expect.stringContaining("HTTPS") });
  });
  it("restores picker state if the UI cannot open", async () => {
    const ctx = createContext();
    ctx.showLoginTUI = () => { throw Error("unavailable"); };
    await expect(loginCommand.execute("", ctx)).rejects.toThrow("unavailable");
    expect(ctx.setPickerActive).toHaveBeenLastCalledWith(false);
  });
});
