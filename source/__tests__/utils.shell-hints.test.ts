import { afterEach, describe, expect, it } from "vitest";
import { agavHomePath, reinstallHint, setEnvHint } from "../utils/shell-hints.js";

const originalPlatform = process.platform;
const originalPSModulePath = process.env.PSModulePath;

function withShell(platform: NodeJS.Platform, psModulePath: string | undefined, fn: () => void): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  if (psModulePath === undefined) delete process.env.PSModulePath;
  else process.env.PSModulePath = psModulePath;
  fn();
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalPSModulePath === undefined) delete process.env.PSModulePath;
  else process.env.PSModulePath = originalPSModulePath;
});

describe("shell hints", () => {
  it("uses POSIX syntax outside Windows", () => {
    withShell("linux", undefined, () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe('export GEMINI_API_KEY="test-key"');
      expect(agavHomePath("config.json")).toBe("~/.agav/config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.sh | bash");
    });
  });

  it("uses PowerShell syntax on Windows PowerShell", () => {
    withShell("win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules", () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe('$env:GEMINI_API_KEY="test-key"');
      expect(agavHomePath("skills/example")).toBe("$HOME\\.agav\\skills\\example");
      expect(reinstallHint()).toBe("irm https://agav.dev/install.ps1 | iex");
    });
  });

  it("uses cmd syntax on Windows when PowerShell is not detected", () => {
    withShell("win32", undefined, () => {
      expect(setEnvHint("GEMINI_API_KEY", "test-key")).toBe("set GEMINI_API_KEY=test-key");
      expect(agavHomePath("config.json")).toBe("%USERPROFILE%\\.agav\\config.json");
      expect(reinstallHint()).toBe("curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd");
    });
  });
});
