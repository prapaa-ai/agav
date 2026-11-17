import { describe, it, expect } from "vitest";

const { renderMathInMarkdown } = await import("../components/markdown-math.js");
const { renderMarkdown } = await import("../components/markdown-text.js");

const ESC = String.fromCharCode(27);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("renderMathInMarkdown — supported conversions", () => {
  it("renders a display \\frac with \\text and operators (the reported case)", () => {
    const input =
      "$$\\frac{14.5\\text{B consumed}}{\\sim 218\\text{B per epoch}} \\approx \\textbf{6–7%}$$";
    expect(renderMathInMarkdown(input)).toBe("(14.5B consumed)/(∼ 218B per epoch) ≈ 6–7%");
  });

  it("converts inline superscripts and subscripts", () => {
    expect(renderMathInMarkdown("value $x^2 + y_i \\le 5$ here")).toBe("value x² + yᵢ ≤ 5 here");
  });

  it("converts \\( ... \\) inline delimiters", () => {
    expect(renderMathInMarkdown("so \\(a \\ne b\\) holds")).toBe("so a ≠ b holds");
  });

  it("converts \\[ ... \\] display delimiters", () => {
    expect(renderMathInMarkdown("set \\[ \\mathbb{R} \\cap \\emptyset \\]")).toBe("set ℝ ∩ ∅");
  });

  it("converts Greek letters and \\sqrt", () => {
    expect(renderMathInMarkdown("$\\alpha\\beta\\gamma$ and $\\sqrt{2}$")).toBe("αβγ and √(2)");
  });

  it("renders E = mc^2 inline", () => {
    expect(renderMathInMarkdown("energy $E = mc^2$")).toBe("energy E = mc²");
  });

  it("maps a wide operator set", () => {
    expect(renderMathInMarkdown("$a \\times b \\cdot c \\to d \\infty \\partial$")).toBe(
      "a × b · c → d ∞ ∂",
    );
  });

  it("keeps function names and strips math-font wrappers", () => {
    expect(renderMathInMarkdown("$\\sin x + \\mathbf{y}$")).toBe("sin x + y");
  });
});

describe("renderMathInMarkdown — false positives are left alone", () => {
  it("does not treat currency amounts as math", () => {
    expect(renderMathInMarkdown("Price is $5 and that costs $10.")).toBe(
      "Price is $5 and that costs $10.",
    );
  });

  it("leaves escaped dollar signs verbatim", () => {
    expect(renderMathInMarkdown("Escaped \\$not math\\$ here.")).toBe(
      "Escaped \\$not math\\$ here.",
    );
  });

  it("ignores dollars inside inline code spans", () => {
    expect(renderMathInMarkdown("Run `echo $x` now.")).toBe("Run `echo $x` now.");
  });

  it("ignores dollars inside fenced code blocks", () => {
    const input = "```sh\nexport A=$B\necho $x^2\n```\n";
    expect(renderMathInMarkdown(input)).toBe(input);
  });

  it("ignores dollars inside link destinations", () => {
    expect(renderMathInMarkdown("Link [a](http://x/$y$) stays.")).toBe(
      "Link [a](http://x/$y$) stays.",
    );
  });

  it("does not fire on inline $...$ spanning a newline", () => {
    const input = "line one $ not\nmath $ line two";
    expect(renderMathInMarkdown(input)).toBe(input);
  });

  it("returns input untouched when there is no math", () => {
    expect(renderMathInMarkdown("No math at all here.")).toBe("No math at all here.");
  });
});

describe("renderMathInMarkdown — unsupported formulas kept verbatim", () => {
  it("restores an unknown macro with its delimiters", () => {
    expect(renderMathInMarkdown("Unsupported $\\unknownmacro{x}$ verbatim.")).toBe(
      "Unsupported $\\unknownmacro{x}$ verbatim.",
    );
  });

  it("leaves an unterminated delimiter literal", () => {
    expect(renderMathInMarkdown("dangling $x + y with no close")).toBe(
      "dangling $x + y with no close",
    );
  });

  it("does not partially render a formula with an unsupported atom", () => {
    // `\foo` is unknown, so the entire span is preserved rather than dropping it.
    expect(renderMathInMarkdown("$a + \\foo + b$")).toBe("$a + \\foo + b$");
  });
});

describe("renderMarkdown integrates math rendering", () => {
  it("renders math inside full markdown output", () => {
    const out = stripAnsi(renderMarkdown("So the estimate: $E = mc^2$ holds.\n"));
    expect(out).toContain("E = mc²");
    expect(out).not.toContain("$");
  });

  it("does not break code blocks containing dollar signs", () => {
    const out = stripAnsi(renderMarkdown("```sh\necho $HOME\n```\n"));
    expect(out).toContain("$HOME");
  });
});
