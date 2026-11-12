import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const originalIsTTY = process.stderr.isTTY;

function setTTY(value: boolean) {
  Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
}

async function loadColor(env: { NO_COLOR?: string; TERM?: string }, isTTY: boolean) {
  vi.resetModules();
  delete process.env["NO_COLOR"];
  delete process.env["TERM"];
  if (env.NO_COLOR !== undefined) process.env["NO_COLOR"] = env.NO_COLOR;
  if (env.TERM !== undefined) process.env["TERM"] = env.TERM;
  setTTY(isTTY);
  return import("../utils/color.js");
}

afterEach(() => {
  for (const key of ["NO_COLOR", "TERM"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  setTTY(originalIsTTY as boolean);
  vi.resetModules();
});

describe("shouldUseColor", () => {
  it.each<[string, { NO_COLOR?: string; TERM?: string }, boolean]>([
    ["NO_COLOR set", { NO_COLOR: "1" }, true],
    ["TERM=dumb", { TERM: "dumb" }, true],
    ["non-TTY stderr", {}, false],
  ])("disables color when %s", async (_label, env, isTTY) => {
    const { shouldUseColor } = await loadColor(env, isTTY);
    expect(shouldUseColor()).toBe(false);
  });
});

describe("dim and icons", () => {
  it("wraps text and uses glyphs when color is on", async () => {
    const { dim, icons } = await loadColor({}, true);
    expect(dim("hi")).toBe("\x1b[2mhi\x1b[0m");
    expect(icons).toEqual({ pending: "⏳", success: "✓", error: "✗", warning: "⚠" });
  });

  it("returns text unchanged and uses fallbacks when color is off", async () => {
    const { dim, icons } = await loadColor({ NO_COLOR: "1" }, true);
    expect(dim("hi")).toBe("hi");
    expect(icons).toEqual({ pending: "...", success: "ok", error: "FAIL", warning: "!!" });
  });
});
