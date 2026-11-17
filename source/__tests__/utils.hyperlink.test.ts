import { describe, it, expect } from "vitest";

import { terminalLink, fileLink, stripTerminalLinks } from "../utils/hyperlink.js";

describe("utils/hyperlink", () => {
  it("creates terminal links", () => {
    expect(terminalLink("text", "https://example.com")).toBe("\x1b]8;;https://example.com\x1b\\text\x1b]8;;\x1b\\");
  });

  it("leaves normal URLs byte-for-byte unchanged", () => {
    const url = "https://example.com/a%20b/c?q=1&r=%E2%9C%93#frag";
    expect(terminalLink("t", url)).toBe(`\x1b]8;;${url}\x1b\\t\x1b]8;;\x1b\\`);
  });

  it("strips control characters so the URL cannot break out of the OSC 8 wrapper", () => {
    const evil = "https://example.com/\x1b\\\x1b]0;pwned\x07\n\r\x9c\x7fend";
    const link = terminalLink("text", evil);
    expect(link).toBe("\x1b]8;;https://example.com/\\]0;pwnedend\x1b\\text\x1b]8;;\x1b\\");
    // Only the ESCs of the opening and closing OSC 8 sequences remain.
    expect(link.match(/\x1b/g)).toHaveLength(4);
    expect(stripTerminalLinks(link)).toBe("text");
  });

  it("creates file links from paths", () => {
    const link = fileLink("file", "/tmp/test file.txt");
    expect(link).toContain("\x1b]8;;file://");
    expect(link).toContain("file");
  });

  it("strips terminal links and leaves plain text", () => {
    const linked = terminalLink("hello", "https://example.com") + " and more";
    expect(stripTerminalLinks(linked)).toBe("hello and more");
  });

  it("strips a link whose visible text contains other escapes, keeping them", () => {
    const bold = "\x1b[1mbold\x1b[22m";
    expect(stripTerminalLinks(terminalLink(bold, "https://example.com"))).toBe(bold);
  });

  it("strips a link directly adjacent to other escape sequences", () => {
    const input = "\x1b[31m" + terminalLink("a", "https://a.example") + "\x1b[0m" + terminalLink("b", "https://b.example");
    expect(stripTerminalLinks(input)).toBe("\x1b[31ma\x1b[0mb");
  });

  it("strips links that use BEL terminators or carry params", () => {
    const input = "\x1b]8;id=x;https://example.com\x07text\x1b]8;;\x07 end";
    expect(stripTerminalLinks(input)).toBe("text end");
  });

  it("leaves text without links unchanged", () => {
    const input = "plain \x1b[1mstyled\x1b[0m text";
    expect(stripTerminalLinks(input)).toBe(input);
  });

  it.each([
    ["ESC \\", "\x1b\\"],
    ["BEL", "\x07"],
  ])("does not pair a leading reset with a later link (%s terminator)", (_name, st) => {
    const reset = `\x1b]8;;${st}`;
    const link = `\x1b]8;;https://a.example${st}a\x1b]8;;${st}`;
    expect(stripTerminalLinks(reset + "plain " + link)).toBe("plain a");
  });

  it("strips consecutive resets followed by a complete link", () => {
    const reset = "\x1b]8;;\x1b\\";
    expect(stripTerminalLinks(reset + reset + "\x1b]8;;\x07" + terminalLink("a", "https://a.example"))).toBe("a");
  });

  it("strips openers that have no closing reset", () => {
    const open = "\x1b]8;;https://a.example\x1b\\";
    expect(stripTerminalLinks(open + "x" + open + "y")).toBe("xy");
  });

  it("leaves an incomplete final control in place", () => {
    const input = terminalLink("a", "https://a.example") + " \x1b]8;;https://b.example";
    expect(stripTerminalLinks(input)).toBe("a \x1b]8;;https://b.example");
  });

  // Regression guard for the quadratic rescan on unclosed openers. The bound is
  // deliberately generous (a linear scan takes a few ms); the old pattern took
  // over a second on this input.
  it("handles ~1 MB of unclosed openers in linear time", { timeout: 10_000 }, () => {
    const open = "\x1b]8;;https://a.example\x1b\\";
    const input = (open + "x").repeat(40_000);
    const started = performance.now();
    expect(stripTerminalLinks(input)).toBe("x".repeat(40_000));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
