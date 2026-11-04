import { describe, expect, it } from "vitest";
import { getRandomHint } from "../utils/hints.js";
import { DEFAULT_KEYBINDINGS, formatKeybinding } from "../config/keybindings.js";

// getRandomHint samples one hint at random. Rather than mock Math.random
// (which destabilizes the test runner), sample enough times to observe the
// whole space with overwhelming probability, then assert membership/absence.
function sample(backgroundJobsEnabled: boolean, iterations = 4000): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < iterations; i++) {
    seen.add(getRandomHint(DEFAULT_KEYBINDINGS, false, backgroundJobsEnabled));
  }
  return seen;
}

describe("getRandomHint detach hint", () => {
  const shortcut = formatKeybinding(DEFAULT_KEYBINDINGS, "detachSession");
  const detachHint = `${shortcut} detaches a running turn — the worker continues; resume with /resume`;

  it("advertises detaching when background jobs are enabled", () => {
    expect(sample(true)).toContain(detachHint);
  });

  it("omits the detach hint when background jobs are disabled", () => {
    for (const hint of sample(false)) expect(hint).not.toContain("detaches a running turn");
  });

  it("defaults to omitting the detach hint", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) seen.add(getRandomHint());
    for (const hint of seen) expect(hint).not.toContain("detaches a running turn");
  });
});
