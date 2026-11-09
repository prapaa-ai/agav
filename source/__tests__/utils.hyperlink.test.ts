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
});
