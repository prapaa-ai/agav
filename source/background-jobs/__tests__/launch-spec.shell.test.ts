import { describe, expect, it } from "vitest";

import { buildShellInvocation, looksLikeBatchShim, resolveShellInterpreter } from "../launch-spec/shell.js";
import { BackgroundJobError } from "../types.js";

describe("resolveShellInterpreter", () => {
  it("defaults to posix-sh on linux/darwin when nothing requested", () => {
    expect(resolveShellInterpreter("linux")).toBe("posix-sh");
    expect(resolveShellInterpreter("darwin")).toBe("posix-sh");
  });

  it("defaults to cmd on win32 when nothing requested", () => {
    expect(resolveShellInterpreter("win32")).toBe("cmd");
  });

  it("honors an explicit compatible request", () => {
    expect(resolveShellInterpreter("linux", "bash")).toBe("bash");
    expect(resolveShellInterpreter("win32", "powershell")).toBe("powershell");
  });

  it("throws BackgroundJobError when requesting a windows interpreter on POSIX", () => {
    expect(() => resolveShellInterpreter("linux", "cmd")).toThrow(BackgroundJobError);
    expect(() => resolveShellInterpreter("linux", "powershell")).toThrow(BackgroundJobError);
    try {
      resolveShellInterpreter("darwin", "cmd");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BackgroundJobError);
      expect((err as BackgroundJobError).code).toBe("unsupported-platform");
    }
  });

  it("throws BackgroundJobError when requesting a POSIX interpreter on win32", () => {
    expect(() => resolveShellInterpreter("win32", "posix-sh")).toThrow(BackgroundJobError);
    expect(() => resolveShellInterpreter("win32", "bash")).toThrow(BackgroundJobError);
  });
});

describe("buildShellInvocation", () => {
  it("builds posix-sh invocation", () => {
    expect(buildShellInvocation("posix-sh", "echo hi")).toEqual({
      executable: "/bin/sh",
      args: ["-c", "echo hi"],
    });
  });

  it("builds bash invocation", () => {
    expect(buildShellInvocation("bash", "echo hi")).toEqual({
      executable: "/bin/bash",
      args: ["-c", "echo hi"],
    });
  });

  it("builds cmd invocation with /d /s /c flags", () => {
    expect(buildShellInvocation("cmd", "dir /w")).toEqual({
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", "dir /w"],
    });
  });

  it("builds powershell invocation", () => {
    expect(buildShellInvocation("powershell", "Get-ChildItem")).toEqual({
      executable: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"],
    });
  });

  it("never translates POSIX syntax into Windows syntax: commandText passed through verbatim", () => {
    const posixStyle = "ls -la | grep foo && echo $HOME";
    expect(buildShellInvocation("cmd", posixStyle).args.at(-1)).toBe(posixStyle);
    expect(buildShellInvocation("posix-sh", posixStyle).args.at(-1)).toBe(posixStyle);
  });
});

describe("looksLikeBatchShim", () => {
  it("detects .cmd and .bat extensions case-insensitively", () => {
    expect(looksLikeBatchShim("C:\\tools\\npm.cmd")).toBe(true);
    expect(looksLikeBatchShim("C:\\tools\\run.BAT")).toBe(true);
    expect(looksLikeBatchShim("/usr/bin/node")).toBe(false);
    expect(looksLikeBatchShim("script.sh")).toBe(false);
  });
});
