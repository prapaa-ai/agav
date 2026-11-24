import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../components/markdown-text.js";

const fence = "```";

describe("fenced code punctuation", () => {
  it("keeps literal emphasis, backticks and star bullets inside a fence", () => {
    const markdown = [
      `${fence}text`,
      "* literal asterisk",
      "**not bold** and `not code`",
      "* a bullet that should stay a bullet",
      fence,
      "",
      "* prose bullet",
    ].join("\n");

    const output = renderMarkdown(markdown);

    expect(output).toContain("* literal asterisk");
    expect(output).toContain("**not bold** and `not code`");
    expect(output).toContain("* a bullet that should stay a bullet");
    expect(output).toContain("• prose bullet");
    // The only bullet rewrite is the real prose bullet.
    expect(output.match(/• /g)?.length).toBe(1);
  });

  it("still applies prose emphasis outside the fence", () => {
    const output = renderMarkdown("outside **bold**");
    expect(output).toContain("outside");
    expect(output).not.toContain("**bold**");
  });
});
