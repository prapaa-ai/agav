import { afterEach, describe, expect, it } from "vitest";
import { agavHomePath, reinstallHint, setEnvHint } from "../utils/shell-hints.js";

const originalPlatform = process.platform;
const originalPSModulePath = process.env.PSModulePath;
const originalPrompt = process.env.PROMPT;

function withShell(
  platform: NodeJS.Platform,
  psModulePath: string | undefined,
  prompt: string | undefined,
  fn: () => void,
): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });

  if (psModulePath === undefined) delete process.env.PSModulePath;
  else process.env.PSModulePath = psModulePath;

  if (prompt === undefined) delete process.env.PROMPT;
  else process.env.PROMPT = prompt;

  fn();
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalPSModulePath === undefined) delete process.env.PSModulePath;
  else process.env.PSModulePath = originalPSModulePath;

  if (originalPrompt === undefined) delete process.env.PROMPT;
  else process.env.PROMPT = originalPrompt;
});

describe("shell hints", () => {
  it("uses POSIX syntax outside Windows", () => {
    withShell("linux", undefined, undefined, () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe('export GEMINI_API_KEY="test-key"');
      expect(agavHomePath("config.json")).toBe("~/.agav/config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.sh | bash");
    });
  });

  it("uses PowerShell syntax on Windows PowerShell", () => {
    withShell("win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules", undefined, () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe('$env:GEMINI_API_KEY="test-key"');
      expect(agavHomePath("skills/example")).toBe("$HOME\\.agav\\skills\\example");
      expect(reinstallHint()).toBe("irm https://agav.dev/install.ps1 | iex");
    });
  });

  it("uses cmd syntax on Windows when PowerShell is not detected", () => {
    withShell("win32", undefined, "C:\\Users\\x>", () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe("set GEMINI_API_KEY=test-key");
      expect(agavHomePath("config.json")).toBe("%USERPROFILE%\\.agav\\config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd");
    });
  });

  it("uses cmd syntax when cmd inherits PSModulePath", () => {
    withShell("win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules", "C:\\Users\\x>", () => {
      expect(setEnvHint("OPENAI_API_KEY", "test-key")).toBe("set OPENAI_API_KEY=test-key");
      expect(agavHomePath("config.json")).toBe("%USERPROFILE%\\.agav\\config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd");
    });
  });
});
