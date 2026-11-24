import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The decision is memoised at module load, so every case re-imports the module
// after stubbing the env and stderr's TTY flag.
async function load(env: Record<string, string | undefined>, isTTY: boolean | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) vi.stubEnv(key, value);
  }
  // stderr has no isTTY outside a terminal, so define one for the import.
  Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true, writable: true });
  return import("../utils/color.js");
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (process.stderr as { isTTY?: boolean }).isTTY;
});

describe("resolveUseColor", () => {
  it("is off whenever NO_COLOR is set, ignoring the TTY", async () => {
    const { resolveUseColor } = await load({}, true);
    expect(resolveUseColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(resolveUseColor({ NO_COLOR: "" }, true)).toBe(false);
  });

  it("honours FORCE_COLOR, including over a dumb terminal", async () => {
    const { resolveUseColor } = await load({}, false);
    expect(resolveUseColor({ FORCE_COLOR: "1", TERM: "dumb" }, false)).toBe(true);
    expect(resolveUseColor({ FORCE_COLOR: "true" }, false)).toBe(true);
    for (const off of ["", "0", "false", " FALSE "]) {
      expect(resolveUseColor({ FORCE_COLOR: off }, true)).toBe(false);
    }
  });

  it("is off for TERM=dumb and otherwise follows the TTY", async () => {
    const { resolveUseColor } = await load({}, false);
    expect(resolveUseColor({ TERM: "dumb" }, true)).toBe(false);
    expect(resolveUseColor({ TERM: "xterm-256color" }, true)).toBe(true);
    expect(resolveUseColor({}, undefined)).toBe(false);
  });
});

describe("colour on", () => {
  it("wraps dim text and uses the glyph icons", async () => {
    const { dim, icons, shouldUseColor } = await load({ FORCE_COLOR: "1" }, false);
    expect(shouldUseColor()).toBe(true);
    expect(dim("quiet")).toBe("\x1b[2mquiet\x1b[0m");
    expect(icons).toEqual({ pending: "⏳", success: "✓", error: "✗", warning: "⚠" });
  });
});

describe("colour off", () => {
  it("returns text unchanged and uses the ASCII fallbacks", async () => {
    const { dim, icons, shouldUseColor } = await load({ NO_COLOR: "1" }, true);
    expect(shouldUseColor()).toBe(false);
    expect(dim("quiet")).toBe("quiet");
    expect(icons).toEqual({ pending: "[..]", success: "[ok]", error: "[XX]", warning: "[!!]" });
  });

  it("is off without a TTY unless forced", async () => {
    const { shouldUseColor } = await load({}, false);
    expect(shouldUseColor()).toBe(false);
  });
});
