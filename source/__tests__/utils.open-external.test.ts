import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extensionForImage, isSafeOpenTarget, openExternal } from "../utils/open-external.js";

describe("extensionForImage", () => {
  it("maps media types to file extensions", () => {
    expect(extensionForImage("image/png")).toBe(".png");
    expect(extensionForImage("image/jpeg")).toBe(".jpg");
    expect(extensionForImage("image/gif")).toBe(".gif");
    expect(extensionForImage("image/webp")).toBe(".webp");
    expect(extensionForImage("image/bmp")).toBe(".bmp");
  });

  it("falls back to .png for unknown types", () => {
    expect(extensionForImage(undefined)).toBe(".png");
    expect(extensionForImage("image/svg+xml")).toBe(".png");
  });
});

describe("isSafeOpenTarget", () => {
  it("accepts URLs with any scheme", () => {
    expect(isSafeOpenTarget("https://example.com")).toBe(true);
    expect(isSafeOpenTarget("http://example.com/path?q=1")).toBe(true);
    // This helper only validates shape, not an allow-list of schemes — a
    // separate concern for callers that need to restrict which schemes are
    // permitted (e.g. http/https only).
    expect(isSafeOpenTarget("vscode://file/some/path")).toBe(true);
    expect(isSafeOpenTarget("mailto:someone@example.com")).toBe(true);
  });

  it("accepts absolute paths", () => {
    expect(isSafeOpenTarget("/tmp/foo.png")).toBe(true);
    if (process.platform === "win32") {
      expect(isSafeOpenTarget("C:\\Users\\foo\\bar.png")).toBe(true);
      expect(isSafeOpenTarget("C:/Users/foo/bar.png")).toBe(true);
    }
  });

  it("rejects relative paths", () => {
    expect(isSafeOpenTarget("foo.png")).toBe(false);
    expect(isSafeOpenTarget("./foo.png")).toBe(false);
    expect(isSafeOpenTarget("../etc/passwd")).toBe(false);
  });

  it("rejects a path starting with -", () => {
    // Not absolute anyway, so this is rejected on that basis, but assert the
    // rejection explicitly since flag-injection is the underlying concern.
    expect(isSafeOpenTarget("-rf /tmp")).toBe(false);
  });
});

// The win32 explorer.exe launcher fix cannot be exercised at runtime in this
// (Linux) CI environment — it is verified by code review against the
// rationale documented for this change (avoiding cmd.exe /c start "" command
// injection). See M2 milestone documentation for details.
if (process.platform === "linux") {
  describe("openExternal no-GUI guard (linux)", () => {
    let savedDisplay: string | undefined;
    let savedWayland: string | undefined;

    beforeEach(() => {
      savedDisplay = process.env["DISPLAY"];
      savedWayland = process.env["WAYLAND_DISPLAY"];
      delete process.env["DISPLAY"];
      delete process.env["WAYLAND_DISPLAY"];
    });

    afterEach(() => {
      if (savedDisplay === undefined) delete process.env["DISPLAY"];
      else process.env["DISPLAY"] = savedDisplay;
      if (savedWayland === undefined) delete process.env["WAYLAND_DISPLAY"];
      else process.env["WAYLAND_DISPLAY"] = savedWayland;
    });

    it("refuses to spawn xdg-open when there is no display", async () => {
      const result = await openExternal("https://example.com");
      expect(result).toBe(false);
    });
  });
}
