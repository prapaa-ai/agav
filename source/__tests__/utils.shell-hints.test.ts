import { afterEach, describe, expect, it } from "vitest";
import { agavHomePath, reinstallHint, setEnvHint } from "../utils/shell-hints.js";

const SHELL_VARS = ["PSModulePath", "PROMPT", "MSYSTEM", "SHELL"] as const;

const originalPlatform = process.platform;
const originalEnv = Object.fromEntries(SHELL_VARS.map((key) => [key, process.env[key]]));

type ShellEnv = Partial<Record<(typeof SHELL_VARS)[number], string>>;

/**
 * Run `fn` with a synthetic platform and shell environment. Every variable in
 * SHELL_VARS is cleared first, so a var the caller omits is genuinely unset
 * rather than leaking in from the host — CI runners set SHELL, which would
 * otherwise make the Windows cases detect as Git Bash.
 */
function withShell(platform: NodeJS.Platform, env: ShellEnv, fn: () => void): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const key of SHELL_VARS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fn();
}

const PS_MODULE_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules";

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  for (const key of SHELL_VARS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("shell hints", () => {
  it("uses POSIX syntax outside Windows", () => {
    withShell("linux", {}, () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe('export GEMINI_API_KEY="test-key"');
      expect(agavHomePath("config.json")).toBe("~/.agav/config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.sh | bash");
    });
  });

  it("uses PowerShell syntax on Windows PowerShell", () => {
    withShell("win32", { PSModulePath: PS_MODULE_PATH }, () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe('$env:GEMINI_API_KEY="test-key"');
      expect(agavHomePath("skills/example")).toBe("$HOME\\.agav\\skills\\example");
      expect(reinstallHint()).toBe("irm https://agav.dev/install.ps1 | iex");
    });
  });

  it("uses cmd syntax on Windows when PowerShell is not detected", () => {
    withShell("win32", { PROMPT: "C:\\Users\\x>" }, () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe("set GEMINI_API_KEY=test-key");
      expect(agavHomePath("config.json")).toBe("%USERPROFILE%\\.agav\\config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd");
    });
  });

  it("uses cmd syntax when cmd inherits PSModulePath", () => {
    withShell("win32", { PSModulePath: PS_MODULE_PATH, PROMPT: "C:\\Users\\x>" }, () => {
      expect(setEnvHint("OPENAI_API_KEY", "test-key")).toBe("set OPENAI_API_KEY=test-key");
      expect(agavHomePath("config.json")).toBe("%USERPROFILE%\\.agav\\config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd");
    });
  });

  // PSModulePath is a machine-level variable, so it is set inside Git Bash too.
  // Without an MSYS check these sessions would be told to use PowerShell syntax.
  it("uses POSIX syntax in Git Bash despite the inherited PSModulePath", () => {
    withShell("win32", { PSModulePath: PS_MODULE_PATH, MSYSTEM: "MINGW64" }, () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe('export GEMINI_API_KEY="test-key"');
      expect(agavHomePath("config.json")).toBe("~/.agav/config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.sh | bash");
    });
  });

  it("uses POSIX syntax when SHELL points at a POSIX shell", () => {
    withShell("win32", { PSModulePath: PS_MODULE_PATH, SHELL: "/usr/bin/bash" }, () => {
      expect(setEnvHint("ANTHROPIC_API_KEY", "test-key")).toBe(
        'export ANTHROPIC_API_KEY="test-key"',
      );
      expect(agavHomePath("plugins")).toBe("~/.agav/plugins");
    });
  });

  // MSYS wins over PROMPT: launching Git Bash from cmd inherits both.
  it("prefers MSYS over an inherited cmd PROMPT", () => {
    withShell("win32", { PROMPT: "C:\\Users\\x>", MSYSTEM: "MINGW64" }, () => {
      expect(setEnvHint("OPENAI_API_KEY", "test-key")).toBe('export OPENAI_API_KEY="test-key"');
    });
  });
});
