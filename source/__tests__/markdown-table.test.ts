import { describe, it, expect } from "vitest";
import stringWidth from "string-width";

const { wrapStyled, fitColumns, renderMarkdown } = await import("../components/markdown-text.js");

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
