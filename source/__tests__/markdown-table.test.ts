import { describe, it, expect, beforeAll } from "vitest";
import stringWidth from "string-width";
import chalk from "chalk";

const { wrapStyled, fitColumns, renderMarkdown, sliceStyled } = await import("../components/markdown-text.js");

const ESC = String.fromCharCode(27);
const bold = (s: string) => `${ESC}[1m${s}${ESC}[22m`;
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("wrapStyled", () => {
  it("returns the input untouched when it already fits", () => {
    expect(wrapStyled("short", 10)).toEqual(["short"]);
  });

  it("never emits a line wider than the limit", () => {
    const samples = [
      "a very long sentence that has to be wrapped across several lines",
      "a 日本語テキストのとても長い単語",
      "https://example.com/an/extremely/long/path/that/cannot/be/broken/on/a/space",
      bold("very_long_identifier_with_no_spaces"),
      "मैं एक बहुत लंबा हिन्दी वाक्य लिख रहा हूँ",
      "✅ ⚠️ 🇺🇸 🇯🇵 emoji mixed with text that keeps going and going",
    ];
    for (const sample of samples) {
      for (const width of [6, 10, 20]) {
        for (const line of wrapStyled(sample, width)) {
          expect(stringWidth(line), `${JSON.stringify(sample)} @ ${width}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("hard-breaks a long token even when it is not the first word", () => {
    const lines = wrapStyled("a 日本語テキストのとても長い単語", 10);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(10);
  });

  it("never splits an escape sequence and closes styles at each break", () => {
    const lines = wrapStyled(bold("very_long_identifier"), 10);
    for (const line of lines) {
      // No dangling ESC without a terminating `m`.
      expect(line).not.toMatch(new RegExp(`${ESC}\\[[0-9;]*$`));
      if (line.includes(ESC)) expect(line.endsWith(`${ESC}[0m`)).toBe(true);
    }
    expect(lines.map(stripAnsi).join("")).toBe("very_long_identifier");
  });

  it("preserves the visible text across a word wrap", () => {
    const lines = wrapStyled("alpha beta gamma delta", 11);
    expect(lines.map(stripAnsi).join(" ")).toBe("alpha beta gamma delta");
  });

  it("keeps grapheme clusters intact", () => {
    for (const line of wrapStyled("🇺🇸🇯🇵🇮🇳🇩🇪🇫🇷", 4)) {
      expect(stringWidth(line)).toBeLessThanOrEqual(4);
      // A split flag would leave a lone regional indicator.
      expect(Array.from(line).length % 2).toBe(0);
    }
  });

  it("treats an embedded newline as a hard break, not a zero-width character to wrap through", () => {
    // Regression: `stringWidth("\n")` is 0, so without an explicit newline
    // split the single-pass wrapper below happily packed several source
    // lines — e.g. every bullet of a rendered markdown list — onto one
    // returned "line", which downstream renders as one `<Box>` row containing
    // a raw "\n" and breaks the terminal display (bullets run together with
    // no visible separation).
    const text = "line one\nline two\nline three";
    const lines = wrapStyled(text, 60);
    expect(lines).toEqual(["line one", "line two", "line three"]);
    for (const line of lines) expect(line.includes("\n")).toBe(false);
  });

  it("wraps each newline-separated segment independently when a segment overflows", () => {
    const text = "short\na very long line that needs to be wrapped across more than one row of output";
    const lines = wrapStyled(text, 20);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(20);
      expect(line.includes("\n")).toBe(false);
    }
    expect(lines[0]).toBe("short");
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain("a very long line that needs to be wrapped across more than one row of output".split(" ")[0]);
  });

  it("reproduces a multi-line bulleted list as one wrapped row per bullet", () => {
    const styled = renderMarkdown("Files:\n- source/app.ts\n- source/utils/attachments.ts\n- source/commands/open.ts\n");
    const lines = wrapStyled(styled, 60);
    const visible = lines.map(stripAnsi);
    expect(visible.filter((l) => l.includes("•")).length).toBe(3);
    for (const line of lines) expect(line.includes("\n")).toBe(false);
  });
});

describe("renderMarkdown does not pre-wrap prose (leaves wrapping to a single downstream pass)", () => {
  // Regression: marked-terminal's own `reflowText` option wrapped prose to a
  // fixed column count *inside* renderMarkdown's own output, inserting a
  // literal "\n" through any inline token (a file path, a URL) long enough to
  // straddle that column. Every caller re-wraps `renderMarkdown`'s result a
  // second time anyway (`wrapStyled` for clickable messages, Ink's own
  // `<Text>` wrapping everywhere else), and detection/click-matching does a
  // literal substring search for the token that was found clickable — a
  // token pre-split by marked-terminal's reflow could never be found as one
  // contiguous substring again, which is why ctrl+click worked for some
  // agent-mentioned paths (short enough to survive intact) and silently
  // failed for others of the exact same kind (long enough to be reflow-split)
  // — depending only on width and per-message text, with no visible sign
  // anything had gone wrong.
  it("keeps a long inline path/URL-like token intact rather than splitting it with an embedded newline", () => {
    const longPath = ".agav-worktrees/vertex-ai-thinking-tokens/source/commands/export.ts";
    const out = renderMarkdown(`See ${longPath} for details.`);
    expect(out).toContain(longPath);
    expect(out.includes("\n")).toBe(false);
  });

  it("keeps a long inline token intact regardless of terminal width", () => {
    const longPath = "source/utils/some-really-quite-long-module-name-here.ts";
    for (const width of [40, 60, 80, 120]) {
      const original = process.stdout.columns;
      process.stdout.columns = width;
      try {
        const out = renderMarkdown(`Check ${longPath} please`);
        expect(out).toContain(longPath);
      } finally {
        process.stdout.columns = original;
      }
    }
  });
});

describe("sliceStyled", () => {
  // chalk paints nothing at all when it cannot detect a colour terminal,
  // which it never can under vitest. Force a level so the escapes the
  // styled-string tests below look for are actually emitted.
  beforeAll(() => {
    chalk.level = 3;
  });

  it("slices a plain unstyled string", () => {
    expect(sliceStyled("hello world", 0, 5)).toBe("hello");
  });

  it("clamps out-of-range indices", () => {
    expect(sliceStyled("hello", 2, 100)).toBe("llo");
    expect(sliceStyled("hello", -5, 3)).toBe("hel");
  });

  it("returns an empty string when end <= start", () => {
    expect(sliceStyled("hello", 3, 3)).toBe("");
    expect(sliceStyled("hello", 4, 2)).toBe("");
  });

  it("loses no visible characters when concatenating slices", () => {
    const styled = chalk.bold("hello ") + "plain " + chalk.underline.cyan("link");
    const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const total = visible(styled).length;
    const a = sliceStyled(styled, 0, 6);
    const b = sliceStyled(styled, 6, 13);
    const c = sliceStyled(styled, 13, total);
    expect(visible(a) + visible(b) + visible(c)).toBe(visible(styled));
  });

  it("keeps a middle slice's own styling recoverable", () => {
    const styled = chalk.bold("hello ") + "plain " + chalk.underline.cyan("link");
    const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const total = visible(styled).length;
    const linkStart = visible(styled).indexOf("link");
    const c = sliceStyled(styled, linkStart, total);
    expect(c).toMatch(/\x1b\[/);
    expect(visible(c)).toBe("link");
  });

  it("never slices inside an escape sequence", () => {
    const styled = chalk.bold("hello ") + "plain " + chalk.underline.cyan("link");
    expect(() => sliceStyled(styled, 0, 1)).not.toThrow();
    const first = sliceStyled(styled, 0, 1);
    const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible(first)).toBe("h");
  });
});

describe("fitColumns", () => {
  const cases: Array<{ natural: number[]; available: number }> = [
    { natural: [20, 20, 20, 20, 20, 20], available: 41 },
    { natural: [10, 10, 10, 10, 10, 10, 10, 10], available: 15 },
    { natural: [40, 40, 40], available: 66 },
    { natural: [30, 4], available: 13 },
    { natural: [100], available: 7 },
    { natural: [3, 3], available: 40 },
  ];

  it("never exceeds the available width", () => {
    for (const { natural, available } of cases) {
      const widths = fitColumns(natural, available);
      const total = widths.reduce((a, b) => a + b, 0);
      expect(total, JSON.stringify({ natural, available, widths })).toBeLessThanOrEqual(available);
      for (const w of widths) expect(w).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps natural widths when the table already fits", () => {
    expect(fitColumns([3, 3], 40)).toEqual([3, 3]);
  });

  it("fills the available width when it has to shrink", () => {
    const widths = fitColumns([10, 10, 10, 10, 10, 10, 10, 10], 15);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(15);
  });
});

describe("renderMarkdown tables", () => {
  const table = [
    "| Fix | Effort | Impact |",
    "|-----|--------|--------|",
    "| Add patchConsole | 1 line | Prevents stray stdout |",
    "| Filter mouse | 6 lines | No garbage text |",
  ].join("\n");

  it("draws unicode box borders", () => {
    const out = renderMarkdown(table);
    expect(out).toContain("┌");
    expect(out).toContain("└");
    expect(out).toContain("│");
  });

  it("rules only under the header, not between every row", () => {
    const out = renderMarkdown(table);
    expect(out.split("\n").filter((l) => l.includes("├")).length).toBe(1);
  });

  it("aligns every row to the same visible width", () => {
    const rows = renderMarkdown(table)
      .split("\n")
      .filter((l) => /[┌├└│]/.test(l))
      .map((l) => stringWidth(stripAnsi(l)));
    expect(new Set(rows).size).toBe(1);
  });

  it("stays within the terminal width for wide content", () => {
    const wide = [
      "| Column | Description |",
      "|--------|-------------|",
      `| https://example.com/${"x".repeat(200)} | ${"word ".repeat(60)} |`,
    ].join("\n");
    const limit = process.stdout.columns ? process.stdout.columns - 4 : 80;
    for (const line of renderMarkdown(wide).split("\n")) {
      if (!/[┌├└│]/.test(line)) continue;
      expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(limit);
    }
  });

  it("keeps CJK and emoji cells aligned", () => {
    const mixed = [
      "| 言語 | Sample |",
      "|------|--------|",
      "| 日本語 | こんにちは |",
      "| Emoji | ✅ ⚠️ 🇺🇸 |",
      "| हिन्दी | नमस्ते |",
    ].join("\n");
    const widths = renderMarkdown(mixed)
      .split("\n")
      .filter((l) => /[┌├└│]/.test(l))
      .map((l) => stringWidth(stripAnsi(l)));
    expect(new Set(widths).size).toBe(1);
  });

  it("styles inline markup inside cells", () => {
    const out = renderMarkdown([
      "| Name | Value |",
      "|------|-------|",
      "| `code` | **bold** |",
    ].join("\n"));
    expect(stripAnsi(out)).toContain("code");
    expect(stripAnsi(out)).not.toContain("`code`");
    expect(stripAnsi(out)).not.toContain("**bold**");
  });
});
