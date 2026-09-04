import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../utils/open-external.js", () => ({
  openExternal: vi.fn(),
  extensionForImage: vi.fn(),
  spoolImageToTempFile: vi.fn(),
}));

vi.mock("../utils/path-guard.js", () => ({
  checkPathBoundary: vi.fn(async () => null),
  isWithinRoot: vi.fn(() => true),
}));

import { execFile } from "node:child_process";
import { openExternal } from "../utils/open-external.js";
import { checkPathBoundary } from "../utils/path-guard.js";
import { openTarget } from "../utils/open-target.js";

const execFileMock = vi.mocked(execFile);
const openExternalMock = vi.mocked(openExternal);
const checkPathBoundaryMock = vi.mocked(checkPathBoundary);

/** Default: every execFile invocation fails, as if no CLI/tool is on PATH. */
function failAllExecFile() {
  execFileMock.mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(new Error("not found"));
    return undefined as any;
  });
}

describe("openTarget", () => {
  let savedEnv: Record<string, string | undefined>;
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    savedEnv = {
      CI: process.env["CI"],
      BROWSER: process.env["BROWSER"],
      TERM_PROGRAM: process.env["TERM_PROGRAM"],
      DISPLAY: process.env["DISPLAY"],
      WAYLAND_DISPLAY: process.env["WAYLAND_DISPLAY"],
      WSL_DISTRO_NAME: process.env["WSL_DISTRO_NAME"],
      WSL_INTEROP: process.env["WSL_INTEROP"],
      SSH_CONNECTION: process.env["SSH_CONNECTION"],
      SSH_TTY: process.env["SSH_TTY"],
    };
    savedIsTTY = process.stdout.isTTY;

    delete process.env["CI"];
    delete process.env["BROWSER"];
    delete process.env["TERM_PROGRAM"];
    delete process.env["WSL_DISTRO_NAME"];
    delete process.env["WSL_INTEROP"];
    delete process.env["SSH_CONNECTION"];
    delete process.env["SSH_TTY"];
    // Not-CI by default: a real TTY, no $CI.
    process.stdout.isTTY = true;

    vi.clearAllMocks();
    checkPathBoundaryMock.mockResolvedValue(null);
    failAllExecFile();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.stdout.isTTY = savedIsTTY as boolean;
  });

  describe("url requests", () => {
    it("opens a valid http(s) URL via openExternal when it succeeds", async () => {
      openExternalMock.mockResolvedValue(true);

      const result = await openTarget({ kind: "url", url: "https://example.com" });

      expect(result.ok).toBe(true);
      expect(result.message).toEqual(expect.stringContaining("https://example.com"));
      expect(openExternalMock).toHaveBeenCalledWith("https://example.com");
    });

    it.each(["javascript:alert(1)", "vscode://foo", "file:///etc/passwd"])(
      "rejects disallowed scheme %s before ever calling openExternal",
      async (url) => {
        const result = await openTarget({ kind: "url", url });

        expect(result.ok).toBe(false);
        expect(result.message.toLowerCase()).toContain("not allowed");
        expect(openExternalMock).not.toHaveBeenCalled();
      },
    );

    it("reports a malformed URL string as invalid", async () => {
      const result = await openTarget({ kind: "url", url: "not a url" });

      expect(result.ok).toBe(false);
      expect(result.message.toLowerCase()).toContain("not a valid url");
      expect(openExternalMock).not.toHaveBeenCalled();
    });

    it("prefers $BROWSER when set, and never reaches openExternal on success", async () => {
      process.env["BROWSER"] = "my-fake-browser";
      execFileMock.mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        if (args[0] === "my-fake-browser" && typeof cb === "function") cb(null, "", "");
        else if (typeof cb === "function") cb(new Error("not found"));
        return undefined as any;
      });

      const result = await openTarget({ kind: "url", url: "https://example.com" });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("$BROWSER");
      expect(openExternalMock).not.toHaveBeenCalled();
    });

    it("refuses to open in CI/non-TTY, surfacing the URL for manual copy", async () => {
      process.env["CI"] = "1";

      const result = await openTarget({ kind: "url", url: "https://example.com" });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("https://example.com");
      expect(openExternalMock).not.toHaveBeenCalled();
    });
  });

  describe("file requests", () => {
    it("reports a nonexistent file as no longer existing", async () => {
      const result = await openTarget({ kind: "file", absPath: "/definitely/does/not/exist/xyz123.ts" });

      expect(result.ok).toBe(false);
      expect(result.message.toLowerCase()).toContain("no longer exists");
    });

    it("surfaces whatever checkPathBoundary returns as the error message", async () => {
      checkPathBoundaryMock.mockResolvedValue("Access denied: /fake/.ssh/id_rsa is inside a protected credential path.");

      const result = await openTarget({ kind: "file", absPath: "/fake/.ssh/id_rsa" });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Cannot open:");
      expect(result.message).toContain("Access denied: /fake/.ssh/id_rsa is inside a protected credential path.");
    });

    it("refuses to open in CI/non-TTY, surfacing the path for manual copy", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agav-open-target-"));
      try {
        const filePath = join(dir, "note.txt");
        await writeFile(filePath, "hello");
        process.env["CI"] = "1";

        const result = await openTarget({ kind: "file", absPath: filePath });

        expect(result.ok).toBe(false);
        expect(result.message).toContain(filePath);
        expect(openExternalMock).not.toHaveBeenCalled();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses an extension that is not in the allow-list", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agav-open-target-"));
      try {
        // `.desktop` is not in INERT_EXTENSIONS.
        const filePath = join(dir, "launcher.desktop");
        await writeFile(filePath, "[Desktop Entry]\nExec=echo hi\n");
        if (process.platform === "linux") process.env["DISPLAY"] = ":0";

        const result = await openTarget({ kind: "file", absPath: filePath });

        expect(result.ok).toBe(false);
        expect(result.message.toLowerCase()).toContain("allow-list");
        expect(openExternalMock).not.toHaveBeenCalled();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("opens an allow-listed file via the platform opener on the happy path", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agav-open-target-"));
      try {
        const filePath = join(dir, "note.txt");
        await writeFile(filePath, "hello");
        if (process.platform === "linux") process.env["DISPLAY"] = ":0";
        openExternalMock.mockResolvedValue(true);

        const result = await openTarget({ kind: "file", absPath: filePath });

        expect(result.ok).toBe(true);
        expect(result.message).toContain(filePath);
        expect(openExternalMock).toHaveBeenCalledWith(filePath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("opens via VS Code CLI when TERM_PROGRAM=vscode and `code` is on PATH", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agav-open-target-"));
      try {
        const filePath = join(dir, "note.txt");
        await writeFile(filePath, "hello");
        process.env["TERM_PROGRAM"] = "vscode";
        if (process.platform === "linux") process.env["DISPLAY"] = ":0";

        execFileMock.mockImplementation((...args: any[]) => {
          const cb = args[args.length - 1];
          const cmd = args[0];
          const cmdArgs = args[1];
          // `commandExists("code")` probe: `which code` (linux) or `where code` (win32).
          if ((cmd === "which" || cmd === "where") && cmdArgs?.[0] === "code") {
            if (typeof cb === "function") cb(null, "/usr/bin/code\n", "");
          } else if (cmd === "code") {
            // `code -r ...` invocation.
            if (typeof cb === "function") cb(null, "", "");
          } else if (typeof cb === "function") {
            cb(new Error("not found"));
          }
          return undefined as any;
        });

        const result = await openTarget({ kind: "file", absPath: filePath });

        expect(result.ok).toBe(true);
        expect(result.message).toContain("VS Code");
        expect(openExternalMock).not.toHaveBeenCalled();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
