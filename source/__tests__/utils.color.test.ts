import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUseColor } from "../utils/color.js";

describe("resolveUseColor", () => {
  it.each([
    // [env, isTTY, expected]
    [{}, true, true],
    [{}, false, false],
    [{}, undefined, false],
    [{ TERM: "dumb" }, true, false],
    [{ NO_COLOR: "" }, true, false],
    [{ NO_COLOR: "1" }, true, false],
    [{ FORCE_COLOR: "1" }, false, true],
    [{ FORCE_COLOR: "3" }, false, true],
    [{ FORCE_COLOR: "true" }, false, true],
    [{ FORCE_COLOR: "1", TERM: "dumb" }, false, true],
    [{ FORCE_COLOR: "0" }, true, false],
    [{ FORCE_COLOR: "false" }, true, false],
    [{ FORCE_COLOR: " FALSE " }, true, false],
    [{ FORCE_COLOR: "" }, true, false],
    [{ FORCE_COLOR: "1", NO_COLOR: "1" }, true, false],
  ] as const)("env %j, isTTY %j → %j", (env, isTTY, expected) => {
    expect(resolveUseColor(env, isTTY)).toBe(expected);
  });
});

describe("color module", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(env: Record<string, string | undefined>) {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("TERM", undefined);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules();
    return import("../utils/color.js");
  }

  it("FORCE_COLOR=1 turns color on whatever the TTY state", async () => {
    const color = await load({ FORCE_COLOR: "1" });
    expect(color.shouldUseColor()).toBe(true);
    expect(color.dim("x")).toBe("\x1b[2mx\x1b[0m");
    expect(color.icons.success).toBe("✓");
  });

  it("FORCE_COLOR=0 turns color off, with plain icons", async () => {
    const color = await load({ FORCE_COLOR: "0" });
    expect(color.shouldUseColor()).toBe(false);
    expect(color.dim("x")).toBe("x");
    expect(color.icons).toEqual({ pending: "[..]", success: "[ok]", error: "[XX]", warning: "[!!]" });
  });

  it("NO_COLOR wins over FORCE_COLOR", async () => {
    const color = await load({ FORCE_COLOR: "1", NO_COLOR: "1" });
    expect(color.shouldUseColor()).toBe(false);
  });
});
