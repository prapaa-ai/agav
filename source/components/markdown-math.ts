//! Terminal-friendly rendering of a small LaTeX math subset.
//!
//! `marked` / CommonMark do not understand math delimiters, so a `$$\frac{a}{b}$$`
//! block prints verbatim in the terminal. This module masks math spans *before*
//! markdown parsing and converts a deliberately bounded TeX subset into Unicode:
//! Greek letters, common operators/relations/arrows, `\frac`, `\sqrt`, `\text`,
//! super/subscripts, and accents. Anything outside the subset is restored
//! verbatim so nothing is silently mangled.
//!
//! The conversion is inline-style: `\frac{a}{b}` becomes `(a)/(b)` rather than a
//! stacked two-row layout, which keeps every rendered formula a single line and
//! safe for the downstream SGR-aware wrapping/slicing passes.

/** Hard cap on a single formula's source length; longer spans are left verbatim. */
const MAX_MATH_BYTES = 4096;

/** LaTeX command name → Unicode symbol. */
const SYMBOLS: Record<string, string> = {
  // Lowercase Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  // Uppercase Greek
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Big operators
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
  bigcup: "⋃", bigcap: "⋂", bigwedge: "⋀", bigvee: "⋁",
  // Misc symbols
  infty: "∞", partial: "∂", nabla: "∇", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ",
  aleph: "ℵ", prime: "′", angle: "∠", dagger: "†", ddagger: "‡",
  // Binary operators
  pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", circ: "∘", bullet: "∙",
  oplus: "⊕", otimes: "⊗", odot: "⊙", ast: "∗", star: "⋆",
  // Relations
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈",
  propto: "∝", sim: "∼", simeq: "≃", cong: "≅", equiv: "≡", ll: "≪", gg: "≫",
  lesssim: "≲", gtrsim: "≳", perp: "⊥", parallel: "∥", doteq: "≐",
  // Set theory & logic
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃",
  supseteq: "⊇", cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅",
  varnothing: "∅", land: "∧", wedge: "∧", lor: "∨", vee: "∨", neg: "¬",
  lnot: "¬", top: "⊤", bot: "⊥", forall: "∀", exists: "∃", nexists: "∄",
  // Arrows
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", mapsto: "↦",
  uparrow: "↑", downarrow: "↓", updownarrow: "↕", Leftarrow: "⇐",
  impliedby: "⇐", Rightarrow: "⇒", implies: "⇒", Leftrightarrow: "⇔", iff: "⇔",
  // Dots
  ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  // Blackboard-bold shortcuts without an argument are not applicable; handled below.
};

/** `\langle` etc. → delimiter character. */
const DELIMITERS: Record<string, string> = {
  langle: "⟨", rangle: "⟩", lbrace: "{", rbrace: "}", lbrack: "[", rbrack: "]",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", vert: "|", Vert: "‖",
  lvert: "|", rvert: "|", lVert: "‖", rVert: "‖",
};

/** `\mathbb{R}` → blackboard-bold letter. */
const BLACKBOARD: Record<string, string> = {
  R: "ℝ", C: "ℂ", N: "ℕ", Z: "ℤ", Q: "ℚ", P: "ℙ", H: "ℍ",
};

/** Function names rendered as-is. */
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh",
  "log", "ln", "exp", "lim", "max", "min", "sup", "inf", "arg", "det",
  "gcd", "deg", "dim", "ker", "mod",
]);

/** Spacing commands that collapse to a single space (or nothing). */
const SPACING: Record<string, string> = {
  quad: " ", qquad: " ", ",": " ", ";": " ", ":": " ", " ": " ", "!": "",
};

const SUPERSCRIPT_PLAIN = "0123456789+-=()abcdefghijklmnoprstuvwxyz";
const SUPERSCRIPT_UNICODE = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ";
const SUBSCRIPT_PLAIN = "0123456789+-=()aehijklmnoprstuvx";
const SUBSCRIPT_UNICODE = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ";

/** Map every character of `text` through a plain→unicode script table, or fail. */
function toScript(text: string, plain: string, unicode: string): string | null {
  let out = "";
  for (const ch of text) {
    const index = plain.indexOf(ch);
    if (index < 0) return null;
    out += unicode[index];
  }
  return out;
}

/**
 * Recursive-descent parser for the TeX subset. Returns the Unicode rendering of
 * the whole input, or `null` for anything it does not fully understand.
 */
class MathParser {
  private remaining: string;
  private depth = 0;
  private fractionBase = false;

  constructor(source: string) {
    this.remaining = source.trim();
  }

  /** Parse the entire input as a sequence; `null` if any atom is unsupported. */
  render(): string | null {
    const result = this.sequence(/*topLevel*/ true);
    if (result === null) return null;
    return result.trim().length === 0 ? null : result;
  }

  private sequence(topLevel: boolean): string | null {
    if (this.depth >= 64) return null;
    this.depth++;
    let out = "";
    let hasFraction = false;
    while (this.remaining.length > 0) {
      if (this.remaining[0] === "}") {
        if (topLevel) {
          this.depth--;
          return null;
        }
        this.remaining = this.remaining.slice(1);
        this.depth--;
        this.fractionBase = hasFraction;
        return out;
      }
      let atom = this.atom();
      if (atom === null) {
        this.depth--;
        return null;
      }
      hasFraction ||= this.fractionBase;
      // Keep a fraction atomic when scripts follow, including through braces
      // and transparent font wrappers. Standalone fractions keep their layout.
      if (this.fractionBase && /^\s*[_^]/.test(this.remaining)) {
        atom = `(${atom})`;
      }
      out += atom;
    }
    this.depth--;
    this.fractionBase = hasFraction;
    // A group that never saw its closing brace is malformed.
    return topLevel ? out : null;
  }

  /** Parse a single `{...}` group, command, script, or literal character. */
  private atom(): string | null {
    this.fractionBase = false;
    const ch = this.remaining[0]!;
    if (ch === "{") {
      this.remaining = this.remaining.slice(1);
      return this.sequence(/*topLevel*/ false);
    }
    if (ch === "\\") {
      this.remaining = this.remaining.slice(1);
      return this.command();
    }
    if (ch === "^" || ch === "_") {
      this.remaining = this.remaining.slice(1);
      return this.script(ch);
    }
    if (ch === "}" || ch === "$" || ch === "#" || ch === "&" || ch === "`") {
      return null;
    }
    this.remaining = this.remaining.slice(1);
    return ch;
  }

  /** Parse a `^`/`_` script and map its argument to Unicode, or fail. */
  private script(kind: "^" | "_"): string | null {
    const arg = this.compactArgument();
    this.fractionBase = false;
    if (arg === null) return null;
    const [plain, unicode] = kind === "^"
      ? [SUPERSCRIPT_PLAIN, SUPERSCRIPT_UNICODE]
      : [SUBSCRIPT_PLAIN, SUBSCRIPT_UNICODE];
    const mapped = toScript(arg, plain, unicode);
    // Fall back to a readable ASCII form rather than failing the whole formula.
    return mapped ?? `${kind}(${arg})`;
  }

  /**
   * Parse the argument of a command/script: a single `{...}` group, a single
   * `\command`, or a single character.
   */
  private compactArgument(): string | null {
    this.fractionBase = false;
    this.remaining = this.remaining.replace(/^\s+/, "");
    if (this.remaining.length === 0) return null;
    const ch = this.remaining[0]!;
    if (ch === "{") {
      this.remaining = this.remaining.slice(1);
      return this.sequence(/*topLevel*/ false);
    }
    if (ch === "\\") {
      this.remaining = this.remaining.slice(1);
      return this.command();
    }
    if (ch === "^" || ch === "_") return null;
    this.remaining = this.remaining.slice(1);
    return ch;
  }

  /** Read a run of `{...}` as literal text (used by `\text{...}`). */
  private literalGroup(): string | null {
    this.remaining = this.remaining.replace(/^\s+/, "");
    if (this.remaining[0] !== "{") return null;
    this.remaining = this.remaining.slice(1);
    const end = this.remaining.indexOf("}");
    if (end < 0) return null;
    const text = this.remaining.slice(0, end);
    // A literal must not hide further markup that we would otherwise render.
    // `%` is tolerated: models commonly write a literal percent inside `\text{}`.
    if (/[{\\$#&]/.test(text)) return null;
    this.remaining = this.remaining.slice(end + 1);
    return text;
  }

  /** Parse a `\command` (name already consumed the leading backslash). */
  private command(): string | null {
    const match = this.remaining.match(/^[a-zA-Z]+/);
    if (!match) {
      // Single-character control sequences: spacing, escaped literals, etc.
      const ch = this.remaining[0];
      if (ch === undefined) return null;
      this.remaining = this.remaining.slice(1);
      if (Object.hasOwn(SPACING, ch)) return SPACING[ch]!;
      if (ch === "{" || ch === "}" || ch === "%" || ch === "$" || ch === "#" || ch === "&" || ch === "_") {
        return ch;
      }
      if (ch === "|") return "‖";
      return null;
    }
    const name = match[0];
    this.remaining = this.remaining.slice(name.length);

    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac": {
        const numerator = this.compactArgument();
        const denominator = this.compactArgument();
        if (numerator === null || denominator === null) return null;
        this.fractionBase = true;
        return `(${numerator})/(${denominator})`;
      }
      case "sqrt": {
        this.remaining = this.remaining.replace(/^\s+/, "");
        if (this.remaining[0] === "[") return null; // nth-root unsupported
        const radicand = this.compactArgument();
        this.fractionBase = false;
        if (radicand === null) return null;
        return `√(${radicand})`;
      }
      case "text":
      case "textbf":
      case "textit":
      case "textrm":
      case "operatorname": {
        return this.literalGroup();
      }
      case "mathrm":
      case "mathbf":
      case "mathit":
      case "mathsf":
      case "mathtt": {
        return this.compactArgument();
      }
      case "mathbb": {
        const arg = this.compactArgument();
        if (arg === null) return null;
        return Object.hasOwn(BLACKBOARD, arg) ? BLACKBOARD[arg]! : null;
      }
      case "hat":
      case "widehat":
      case "bar":
      case "tilde":
      case "vec":
      case "dot":
      case "ddot": {
        const arg = this.compactArgument();
        if (arg === null || [...arg].length !== 1) return null;
        const accent = {
          hat: "\u0302", widehat: "\u0302", bar: "\u0304", tilde: "\u0303",
          vec: "\u20d7", dot: "\u0307", ddot: "\u0308",
        }[name]!;
        return arg + accent;
      }
      case "left":
      case "right":
      case "bigl":
      case "bigr":
      case "big":
      case "Big": {
        this.remaining = this.remaining.replace(/^\s+/, "");
        const d = this.remaining[0];
        if (d === undefined) return null;
        this.remaining = this.remaining.slice(1);
        if (d === ".") return "";
        if (d === "(" || d === ")" || d === "[" || d === "]" || d === "|") return d;
        if (d === "<") return "⟨";
        if (d === ">") return "⟩";
        if (d === "\\") {
          const dm = this.remaining.match(/^[a-zA-Z]+/);
          if (!dm) return null;
          this.remaining = this.remaining.slice(dm[0].length);
          return Object.hasOwn(DELIMITERS, dm[0]) ? DELIMITERS[dm[0]]! : null;
        }
        return null;
      }
      default: {
        if (Object.hasOwn(SPACING, name)) return SPACING[name]!;
        if (FUNCTIONS.has(name)) return name;
        if (Object.hasOwn(SYMBOLS, name)) return SYMBOLS[name]!;
        if (Object.hasOwn(DELIMITERS, name)) return DELIMITERS[name]!;
        return null;
      }
    }
  }
}

/** Convert one LaTeX formula to Unicode, or `null` if it is not fully supported. */
function renderFormula(source: string): string | null {
  if (source.length === 0 || source.length >= MAX_MATH_BYTES) return null;
  try {
    return new MathParser(source).render();
  } catch {
    return null;
  }
}

/** Is the backslash/dollar at `index` escaped by an odd run of backslashes? */
function isEscaped(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

/**
 * Spans that must never be scanned for math: fenced code blocks, inline code,
 * and link/image destinations. Returns sorted, non-overlapping [start, end)
 * ranges into `text`.
 */
function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // A closer must use the same character and at least the opening run's
  // length. Unclosed fences extend through EOF (including streaming output).
  let openFence: { start: number; run: string } | undefined;
  const lines = /[^\n]+(?:\n|$)|\n/g;
  for (let line = lines.exec(text); line; line = lines.exec(text)) {
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line[0]);
    if (!match) continue;
    const run = match[1]!;
    const info = match[2]!;
    if (openFence) {
      if (run[0] === openFence.run[0] && run.length >= openFence.run.length && /^[ \t]*$/.test(info)) {
        ranges.push([openFence.start, line.index + line[0].length]);
        openFence = undefined;
      }
    } else if (run[0] !== "`" || !info.includes("`")) {
      openFence = { start: line.index, run };
    }
  }
  if (openFence) ranges.push([openFence.start, text.length]);
  // Inline code spans: runs of backticks balanced by the same count.
  const inline = /(`+)(?:[^`]|(?!\1)`)*?\1/g;
  for (let m = inline.exec(text); m; m = inline.exec(text)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Markdown link/image destinations: [label](dest).
  const link = /!?\[[^\]]*\]\([^)]*\)/g;
  for (let m = link.exec(text); m; m = link.exec(text)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // Merge overlaps so a single peek-ahead pointer stays monotonic.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const DELIMS: Array<{ open: string; close: string; display: boolean }> = [
  { open: "$$", close: "$$", display: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
  { open: "$", close: "$", display: false },
];

/**
 * Replace LaTeX math spans in `text` with their Unicode rendering, leaving code,
 * links, and unsupported formulas untouched. This runs *before* markdown parsing
 * so the dollar delimiters never reach `marked`. The optional callback protects
 * converted text from subsequent Markdown interpretation.
 */
export function renderMathInMarkdown(
  text: string,
  protect: (rendered: string) => string = (rendered) => rendered,
): string {
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) {
    return text;
  }
  const ranges = protectedRanges(text);
  let rangeIndex = 0;
  let out = "";
  let i = 0;

  while (i < text.length) {
    // Skip past any protected range that starts at or before the cursor.
    while (rangeIndex < ranges.length && ranges[rangeIndex]![1] <= i) rangeIndex++;
    const range = ranges[rangeIndex];
    if (range && i >= range[0] && i < range[1]) {
      out += text.slice(i, range[1]);
      i = range[1];
      continue;
    }

    const rest = text.slice(i);
    const delim = DELIMS.find((d) => rest.startsWith(d.open));
    if (!delim || isEscaped(text, i)) {
      out += text[i];
      i++;
      continue;
    }

    const contentStart = i + delim.open.length;
    const body = text.slice(contentStart);
    // `$x$` must not fire on a bare `$5` (price) etc. — require non-space/non-paren start.
    if (delim.open === "$" && /^[\s({]/.test(body)) {
      out += text[i];
      i++;
      continue;
    }

    // Find the matching closer that is not escaped and not inside a protected range.
    let closeAt = -1;
    let searchFrom = contentStart;
    while (true) {
      const found = text.indexOf(delim.close, searchFrom);
      if (found < 0) break;
      if (isEscaped(text, found)) {
        searchFrom = found + 1;
        continue;
      }
      // Reject a closer that falls inside a later protected range.
      let inProtected = false;
      for (let r = rangeIndex; r < ranges.length && ranges[r]![0] < found + delim.close.length; r++) {
        if (ranges[r]![0] <= found && found < ranges[r]![1]) { inProtected = true; break; }
      }
      if (inProtected) { searchFrom = found + 1; continue; }
      closeAt = found;
      break;
    }

    if (closeAt < 0) {
      // Unterminated delimiter — emit literally and move on.
      out += text[i];
      i++;
      continue;
    }

    const formula = text.slice(contentStart, closeAt);
    // Inline `$...$` spanning a newline is almost always a false positive.
    if (!delim.display && formula.includes("\n")) {
      out += text[i];
      i++;
      continue;
    }
    // A closer cannot follow whitespace or precede an alphanumeric character.
    // This keeps prices like `$5 and $10` literal while allowing closed `$3$`.
    if (delim.open === "$") {
      const next = text[closeAt + delim.close.length];
      if (next && /[A-Za-z0-9]/.test(next)) {
        out += text[i];
        i++;
        continue;
      }
      if (/\s$/.test(formula)) {
        out += text[i];
        i++;
        continue;
      }
    }

    const rendered = renderFormula(formula);
    if (rendered === null) {
      // Unsupported: keep the whole span verbatim, including delimiters.
      const span = text.slice(i, closeAt + delim.close.length);
      out += span;
      i = closeAt + delim.close.length;
      continue;
    }

    out += protect(rendered);
    i = closeAt + delim.close.length;
  }

  return out;
}
