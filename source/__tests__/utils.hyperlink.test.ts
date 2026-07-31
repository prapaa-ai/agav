import { describe, it, expect } from "vitest";

import { terminalLink, fileLink, stripTerminalLinks } from "../utils/hyperlink.js";

describe("utils/hyperlink", () => {
  it("creates terminal links", () => {
    expect(terminalLink("text", "https://example.com")).toBe("\x1b]8;;https://example.com\x1b\\text\x1b]8;;\x1b\\");
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
