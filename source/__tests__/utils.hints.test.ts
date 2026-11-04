import { describe, expect, it, vi } from "vitest";
import { getRandomHint } from "../utils/hints.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

// Sweep a uniform grid finer than the hint list. Advance on EVERY random draw,
// including retries of the previous index, so the no-repeat loop cannot stall.
// Keep a hard limit so a regression fails rather than hanging or exhausting memory.
function collectHints(nextHint: () => string): Set<string> {
  const steps = 256;
  let draws = 0;
  const random = vi.spyOn(Math, "random").mockImplementation(() => {
    if (draws >= steps * steps) throw new Error("Hint selection exceeded its random-draw budget");
    return ((draws++ % steps) + 0.5) / steps;
  });
  try {
    const seen = new Set<string>();
    for (let i = 0; i < steps; i++) seen.add(nextHint());
    // If the pool outgrows the grid, increase the resolution rather than silently
    // checking only a subset of hints.
    expect(seen.size).toBeLessThan(steps);
    return seen;
  } finally {
    random.mockRestore();
  }
}

describe("getRandomHint detach hint", () => {
  const detachHint = "Ctrl+D detaches a running turn — the worker continues; resume with /resume";

  it("advertises detaching when background jobs are enabled", () => {
    expect(collectHints(() => getRandomHint(DEFAULT_KEYBINDINGS, false, true))).toContain(detachHint);
  });

  it("omits the detach hint when background jobs are disabled", () => {
    for (const hint of collectHints(() => getRandomHint(DEFAULT_KEYBINDINGS, false, false))) {
      expect(hint).not.toContain("detaches a running turn");
    }
  });

  it("defaults to omitting the detach hint", () => {
    for (const hint of collectHints(() => getRandomHint())) expect(hint).not.toContain("detaches a running turn");
  });

  it("uses the configured detach chord instead of the default shortcut", () => {
    const keybindings = { ...DEFAULT_KEYBINDINGS, detachSession: ["ctrl+k ctrl+e"] };
    const hints = collectHints(() => getRandomHint(keybindings, false, true));
    expect(hints).toContain("Ctrl+K Ctrl+E detaches a running turn — the worker continues; resume with /resume");
    expect(hints).not.toContain(detachHint);
  });
});
