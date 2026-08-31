import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";

// Mock execFile so we don't touch the real clipboard.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

describe("getClipboardText", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("reads text via pbpaste on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExecFile.mockImplementation(((cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "pbpaste") {
        cb(null, "hello from clipboard", "");
      } else {
        cb(new Error("not found"));
      }
    }) as typeof execFile);

    const { getClipboardText } = await import("../utils/clipboard-text.js");
    const result = await getClipboardText();
    expect(result).toBe("hello from clipboard");
    expect(mockExecFile).toHaveBeenCalledWith("pbpaste", [], expect.any(Object), expect.any(Function));
  });

  it("reads text via powershell on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExecFile.mockImplementation(((cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "powershell.exe") {
        cb(null, "windows clipboard text\r\n", "");
      } else {
        cb(new Error("not found"));
      }
    }) as typeof execFile);

    const { getClipboardText } = await import("../utils/clipboard-text.js");
    const result = await getClipboardText();
    expect(result).toBe("windows clipboard text\r\n");
    expect(mockExecFile).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Clipboard"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("falls through clipboard commands on Linux until one succeeds", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const calls: string[] = [];
    mockExecFile.mockImplementation(((cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      calls.push(cmd);
      if (cmd === "xclip") {
        cb(null, "linux text", "");
      } else {
        cb(new Error("not found"));
      }
    }) as typeof execFile);

    const { getClipboardText } = await import("../utils/clipboard-text.js");
    const result = await getClipboardText();
    expect(result).toBe("linux text");
    // Should have tried xsel first, then xclip.
    expect(calls).toEqual(["xsel", "xclip"]);
  });

  it("returns null when all commands fail", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error("not found"));
    }) as typeof execFile);

    const { getClipboardText } = await import("../utils/clipboard-text.js");
    const result = await getClipboardText();
    expect(result).toBeNull();
  });

  it("returns null when clipboard is empty", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, "", "");
    }) as typeof execFile);

    const { getClipboardText } = await import("../utils/clipboard-text.js");
    const result = await getClipboardText();
    expect(result).toBeNull();
  });
});
