import { describe, it, expect, afterEach, vi } from "vitest";

describe("no-color icon fallbacks", () => {
  afterEach(() => {
    delete process.env["NO_COLOR"];
    vi.resetModules();
  });

  it("uses fixed-width fallback glyphs", async () => {
    process.env["NO_COLOR"] = "1";
    vi.resetModules();
    const { icons } = await import("../utils/color.js");
    const widths = Object.values(icons).map((s) => s.length);
    expect(widths).toEqual([4, 4, 4, 4]);
  });
});
