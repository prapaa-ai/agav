import { describe, it, expect, afterEach } from "vitest";
import { getCurrentBinaryPath, detectManagedLayout } from "../utils/auto-update.js";

/** process.execPath is read-only in type terms but writable at runtime. */
function withExecPath<T>(value: string, fn: () => T): T {
  const original = process.execPath;
  Object.defineProperty(process, "execPath", { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "execPath", { value: original, configurable: true });
  }
}

describe("getCurrentBinaryPath", () => {
  afterEach(() => {
    // guard against a leaked override if a test throws mid-way
    expect(typeof process.execPath).toBe("string");
  });

  it("allows a compiled standalone binary", () => {
    const p = "/Users/x/.agav/packages/standalone/releases/0.1.3/agav";
    expect(withExecPath(p, getCurrentBinaryPath)).toBe(p);
  });

  it("allows a plain binary on PATH", () => {
    const p = "/usr/local/bin/agav";
    expect(withExecPath(p, getCurrentBinaryPath)).toBe(p);
  });

  it("allows an arch-suffixed binary", () => {
    const p = "/tmp/agav-darwin-arm64";
    expect(withExecPath(p, getCurrentBinaryPath)).toBe(p);
  });

  // Regression: Bun sets argv[0] to the literal "bun" inside a compiled
  // binary, so the old argv[0]-based check returned null for every release
  // and auto-update never ran. execPath is the real path — verify we key off
  // it and are NOT fooled by argv[0].
  it("is not affected by Bun's argv[0] being the literal 'bun'", () => {
    const originalArgv = process.argv;
    process.argv = ["bun", "/$bunfs/root/agav-darwin-arm64", "update"];
    try {
      const p = "/Users/x/.agav/packages/standalone/releases/0.1.3/agav";
      expect(withExecPath(p, getCurrentBinaryPath)).toBe(p);
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    ["/usr/local/bin/node", "node"],
    ["/Users/x/.bun/bin/bun", "bun"],
    ["/usr/bin/deno", "deno"],
    ["/usr/local/bin/npx", "npx"],
    ["/usr/local/bin/tsx", "tsx"],
  ])("refuses to overwrite the %s runtime", (p) => {
    expect(withExecPath(p, getCurrentBinaryPath)).toBeNull();
  });

  it("refuses a binary that isn't ours", () => {
    expect(withExecPath("/usr/local/bin/something-else", getCurrentBinaryPath)).toBeNull();
  });
});

describe("detectManagedLayout", () => {
  it("recognises the installer's versioned layout", () => {
    const layout = detectManagedLayout(
      "/Users/x/.agav/packages/standalone/releases/0.1.2/agav",
    );
    expect(layout).toEqual({
      releasesDir: "/Users/x/.agav/packages/standalone/releases",
      currentLink: "/Users/x/.agav/packages/standalone/current",
      binaryName: "agav",
    });
  });

  it("works for a relocated AGAV_HOME (detection is structural, not env-based)", () => {
    const layout = detectManagedLayout("/opt/tools/packages/standalone/releases/2.0.0/agav");
    expect(layout?.currentLink).toBe("/opt/tools/packages/standalone/current");
    expect(layout?.releasesDir).toBe("/opt/tools/packages/standalone/releases");
  });

  it("returns null for a plain binary", () => {
    expect(detectManagedLayout("/usr/local/bin/agav")).toBeNull();
  });

  it("returns null for a lookalike path", () => {
    expect(detectManagedLayout("/a/b/releases/0.1.0/agav")).toBeNull();
    expect(detectManagedLayout("/a/standalone/other/0.1.0/agav")).toBeNull();
  });

  it("returns null for a short path", () => {
    expect(detectManagedLayout("/agav")).toBeNull();
    expect(detectManagedLayout("agav")).toBeNull();
  });
});
