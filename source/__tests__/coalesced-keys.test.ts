import { describe, it, expect } from "vitest";
import { splitCoalescedKeys } from "../ink/parse-keypress.js";

// A read off the terminal is not a keypress. Hold a key down and autorepeat
// delivers several before the event loop comes back around, and the busier the
// app is — a resumed session with a long transcript, say — the more pile up.
// `parseKeypress` reads a whole chunk as one key, so the surplus was lost, and
// a run of DELs was lost in the worst possible way: matching no key name, it
// reached the app as text and got inserted, leaving invisible delete characters
// where a deletion should have been.

describe("splitCoalescedKeys", () => {
  it("splits a run of backspaces", () => {
    expect(splitCoalescedKeys("\x7f\x7f\x7f\x7f")).toEqual([
      "\x7f",
      "\x7f",
      "\x7f",
      "\x7f",
    ]);
  });

  it("splits a run of arrow keys", () => {
    expect(splitCoalescedKeys("\x1b[D\x1b[D\x1b[D")).toEqual([
      "\x1b[D",
      "\x1b[D",
      "\x1b[D",
    ]);
  });

  it("splits a mixed run of control keys and escape sequences", () => {
    expect(splitCoalescedKeys("\x7f\x1b[D\r")).toEqual(["\x7f", "\x1b[D", "\r"]);
  });

  it("leaves a single key alone", () => {
    expect(splitCoalescedKeys("\x7f")).toBeNull();
    expect(splitCoalescedKeys("\x1b[D")).toBeNull();
  });

  it("leaves typed text alone", () => {
    // Autorepeat on a printable key is already handled correctly: the chunk is
    // inserted verbatim, which is what four of the same character should do.
    expect(splitCoalescedKeys("aaaa")).toBeNull();
    expect(splitCoalescedKeys("hello")).toBeNull();
  });

  it("leaves a paste alone", () => {
    // On a terminal without bracketed paste the whole block arrives as one
    // chunk and must stay one chunk, or a paste becomes a storm of keypresses.
    expect(splitCoalescedKeys("some pasted\ntext")).toBeNull();
    expect(splitCoalescedKeys("\x1b[200~pasted\x1b[201~")).toBeNull();
  });

  it("leaves an unresolved escape prefix alone", () => {
    // A bare ESC is a sequence this cannot parse; guessing at the boundary
    // would be worse than passing the chunk through untouched.
    expect(splitCoalescedKeys("\x1b\x1b")).toBeNull();
    expect(splitCoalescedKeys("\x7f\x1b")).toBeNull();
  });

  it("splits a run of Kitty CSI-u sequences", () => {
    // \x1b[127u  = Backspace in Kitty protocol
    // \x1b[13;2u = Shift+Enter
    // \x1b[97u   = 'a' (codepoint 97)
    const run = "\x1b[127u\x1b[13;2u\x1b[97u";
    expect(splitCoalescedKeys(run)).toEqual([
      "\x1b[127u",
      "\x1b[13;2u",
      "\x1b[97u",
    ]);
  });

  it("leaves pasted emoji text alone", () => {
    // Emoji strings should be treated as a single paste, not split.
    // The flag emoji 🇺🇸 is 4 code units; the family emoji 👨‍👩‍👧‍👦 is 11.
    expect(splitCoalescedKeys("hello 🇺🇸 world")).toBeNull();
    expect(splitCoalescedKeys("👨‍👩‍👧‍👦")).toBeNull();
    expect(splitCoalescedKeys("abc🎉def")).toBeNull();
  });
});
