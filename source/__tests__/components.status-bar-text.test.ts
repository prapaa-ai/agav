import { describe, expect, it } from "vitest";
import { buildStatusBarText, type StatusBarSegments } from "../components/status-bar.js";
import { defaultStatusBarLayout, type StatusBarLayout } from "../config/status-bar-layout.js";

const FULL: StatusBarSegments = {
  model: "anthropic/claude",
  effort: "effort: high",
  messages: "3 msgs",
  usage: "10 ↑ 5 ↓",
  duration: "⏱ 1.2s",
  sandbox: "sandbox: seatbelt",
  session: "session: abc12345",
};

describe("buildStatusBarText", () => {
  it("renders the default layout in catalog order joined by ' · '", () => {
    expect(buildStatusBarText(FULL)).toBe(
      "anthropic/claude · effort: high · 3 msgs · 10 ↑ 5 ↓ · ⏱ 1.2s · sandbox: seatbelt · session: abc12345",
    );
  });

  it("skips segments with empty text, leaving no dangling separators", () => {
    const segments: StatusBarSegments = { ...FULL, sandbox: "", session: "", duration: "" };
    expect(buildStatusBarText(segments)).toBe(
      "anthropic/claude · effort: high · 3 msgs · 10 ↑ 5 ↓",
    );
  });

  it("honors a custom order", () => {
    const layout: StatusBarLayout = [
      { id: "usage", enabled: true },
      { id: "model", enabled: true },
      { id: "effort", enabled: false },
      { id: "messages", enabled: false },
      { id: "duration", enabled: false },
      { id: "sandbox", enabled: false },
      { id: "session", enabled: false },
    ];
    expect(buildStatusBarText(FULL, layout)).toBe("10 ↑ 5 ↓ · anthropic/claude");
  });

  it("omits disabled segments entirely", () => {
    const layout = defaultStatusBarLayout().map((item) =>
      item.id === "usage" || item.id === "sandbox" ? { ...item, enabled: false } : item,
    );
    expect(buildStatusBarText(FULL, layout)).toBe(
      "anthropic/claude · effort: high · 3 msgs · ⏱ 1.2s · session: abc12345",
    );
  });

  it("returns an empty string when everything is hidden", () => {
    const layout = defaultStatusBarLayout().map((item) => ({ ...item, enabled: false }));
    expect(buildStatusBarText(FULL, layout)).toBe("");
  });

  it("never renders the hint as an inline segment even if present", () => {
    // The hint is its own line; it must not join the inline comma list.
    const segments: StatusBarSegments = { model: "anthropic/claude", hint: "some tip" };
    expect(buildStatusBarText(segments)).toBe("anthropic/claude");
  });

  it("tolerates a stale/partial saved layout by normalizing first", () => {
    // Only 'model' is saved; the rest are appended enabled by normalization.
    const layout = [{ id: "model", enabled: true }] as StatusBarLayout;
    expect(buildStatusBarText(FULL, layout)).toBe(
      "anthropic/claude · effort: high · 3 msgs · 10 ↑ 5 ↓ · ⏱ 1.2s · sandbox: seatbelt · session: abc12345",
    );
  });
});
