import { describe, expect, it } from "vitest";
import {
  STATUS_BAR_ITEMS,
  INLINE_STATUS_BAR_ITEMS,
  defaultStatusBarLayout,
  enabledStatusBarItems,
  isDefaultStatusBarLayout,
  isStatusBarItemEnabled,
  normalizeStatusBarLayout,
  statusBarItemMeta,
  type StatusBarLayout,
} from "../config/status-bar-layout.js";

const ALL_IDS = STATUS_BAR_ITEMS.map((item) => item.id);

describe("defaultStatusBarLayout", () => {
  it("lists every catalog item enabled, in catalog order", () => {
    const layout = defaultStatusBarLayout();
    expect(layout.map((i) => i.id)).toEqual(ALL_IDS);
    expect(layout.every((i) => i.enabled)).toBe(true);
  });
});

describe("normalizeStatusBarLayout", () => {
  it("returns the default for non-arrays", () => {
    expect(normalizeStatusBarLayout(undefined)).toEqual(defaultStatusBarLayout());
    expect(normalizeStatusBarLayout(null)).toEqual(defaultStatusBarLayout());
    expect(normalizeStatusBarLayout("nope")).toEqual(defaultStatusBarLayout());
    expect(normalizeStatusBarLayout({})).toEqual(defaultStatusBarLayout());
  });

  it("preserves saved order and enabled flags", () => {
    const saved: StatusBarLayout = [
      { id: "usage", enabled: false },
      { id: "model", enabled: true },
    ];
    const result = normalizeStatusBarLayout(saved);
    // Saved items keep their order, then the rest append in catalog order.
    expect(result.slice(0, 2)).toEqual([
      { id: "usage", enabled: false },
      { id: "model", enabled: true },
    ]);
    expect(result.map((i) => i.id).sort()).toEqual([...ALL_IDS].sort());
  });

  it("appends newly shipped catalog items (enabled) a stale layout never mentioned", () => {
    const stale: StatusBarLayout = [{ id: "model", enabled: true }];
    const result = normalizeStatusBarLayout(stale);
    expect(result[0]).toEqual({ id: "model", enabled: true });
    // Every other catalog item is appended, enabled.
    for (const id of ALL_IDS) {
      const entry = result.find((i) => i.id === id)!;
      expect(entry).toBeDefined();
      if (id !== "model") expect(entry.enabled).toBe(true);
    }
    expect(result).toHaveLength(ALL_IDS.length);
  });

  it("drops unknown ids, malformed entries, and duplicates (first wins)", () => {
    const raw = [
      { id: "model", enabled: false },
      { id: "model", enabled: true }, // duplicate ignored
      { id: "bogus", enabled: true }, // unknown dropped
      null,                            // malformed dropped
      42,                              // malformed dropped
      { enabled: true },               // missing id dropped
    ];
    const result = normalizeStatusBarLayout(raw);
    expect(result.filter((i) => i.id === "model")).toHaveLength(1);
    expect(result.find((i) => i.id === "model")!.enabled).toBe(false);
    expect(result.some((i) => (i.id as string) === "bogus")).toBe(false);
    expect(result).toHaveLength(ALL_IDS.length);
  });

  it("treats a layout with no recognized items as absent", () => {
    expect(normalizeStatusBarLayout([{ id: "bogus" }, null])).toEqual(defaultStatusBarLayout());
  });

  it("defaults a missing enabled flag to true, but respects an explicit false", () => {
    const result = normalizeStatusBarLayout([{ id: "model" }, { id: "usage", enabled: false }]);
    expect(result.find((i) => i.id === "model")!.enabled).toBe(true);
    expect(result.find((i) => i.id === "usage")!.enabled).toBe(false);
  });
});

describe("enabledStatusBarItems", () => {
  it("returns only enabled ids in order", () => {
    const layout: StatusBarLayout = [
      { id: "model", enabled: true },
      { id: "effort", enabled: false },
      { id: "usage", enabled: true },
    ];
    expect(enabledStatusBarItems(layout)).toEqual(["model", "usage"]);
  });
});

describe("isDefaultStatusBarLayout", () => {
  it("is true only for the exact default", () => {
    expect(isDefaultStatusBarLayout(defaultStatusBarLayout())).toBe(true);
  });

  it("is false when order differs", () => {
    const reordered = defaultStatusBarLayout().reverse();
    expect(isDefaultStatusBarLayout(reordered)).toBe(false);
  });

  it("is false when anything is disabled", () => {
    const layout = defaultStatusBarLayout();
    layout[0]!.enabled = false;
    expect(isDefaultStatusBarLayout(layout)).toBe(false);
  });

  it("is false when the length differs", () => {
    expect(isDefaultStatusBarLayout([{ id: "model", enabled: true }])).toBe(false);
  });
});

describe("statusBarItemMeta", () => {
  it("returns metadata for every catalog id", () => {
    for (const id of ALL_IDS) {
      const meta = statusBarItemMeta(id);
      expect(meta.id).toBe(id);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });
});

describe("hint segment", () => {
  it("is part of the catalog but not an inline segment", () => {
    expect(ALL_IDS).toContain("hint");
    expect(INLINE_STATUS_BAR_ITEMS).not.toContain("hint");
    // Every inline id is a real catalog id.
    for (const id of INLINE_STATUS_BAR_ITEMS) expect(ALL_IDS).toContain(id);
  });

  it("is enabled by default", () => {
    expect(isStatusBarItemEnabled(defaultStatusBarLayout(), "hint")).toBe(true);
  });

  it("isStatusBarItemEnabled reflects an explicit disable", () => {
    const layout: StatusBarLayout = defaultStatusBarLayout().map((item) =>
      item.id === "hint" ? { ...item, enabled: false } : item,
    );
    expect(isStatusBarItemEnabled(layout, "hint")).toBe(false);
    expect(isStatusBarItemEnabled(layout, "model")).toBe(true);
  });

  it("isStatusBarItemEnabled defaults a missing entry to enabled", () => {
    // A stale layout that predates the hint item: normalization appends it enabled.
    const stale: StatusBarLayout = [{ id: "model", enabled: true }];
    expect(isStatusBarItemEnabled(stale, "hint")).toBe(true);
  });
});
