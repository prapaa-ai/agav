import React from "react";
import { Text } from "../ink/index.js";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import stringWidth from "string-width";

/** Usable width for rendered markdown, read fresh so terminal resizes are honoured. */
function currentWidth(): number {
  return process.stdout.columns ? process.stdout.columns - 4 : 80;
}

/** Render a single inline token to styled terminal text. */
function renderInlineToken(t: any): string {
  // `codespan` holds its content verbatim; everything else may nest, so recurse
  // to keep combinations like `**bold `code`**` styled.
  if (t.type === "codespan") return chalk.bold.yellow(t.text ?? t.raw ?? "");
  const inner = Array.isArray(t.tokens) && t.tokens.length > 0
    ? t.tokens.map(renderInlineToken).join("")
    : (t.text ?? t.raw ?? "");
  switch (t.type) {
    case "strong": return chalk.bold(inner);
    case "em": return chalk.italic(inner);
    case "del": return chalk.strikethrough(inner);
    case "link": return t.title ? `${chalk.underline.blue(inner)} (${t.href})` : chalk.underline.blue(inner);
    default: return inner;
  }
}

/** Matches a single SGR escape sequence — the only kind chalk emits. */
const SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const RESET = "\x1b[0m";

/** Strip ANSI escape sequences to get the visible text. */
function stripAnsi(s: string): string {
  return s.replace(new RegExp(SGR_PATTERN, "g"), "");
}

/**
 * Strip Unicode variation selectors that cause width measurement
 * inconsistencies across string-width versions and terminals.
 */
function stripVariationSelectors(s: string): string {
  return s.replace(/[︎️]/g, "");
}

/** Pad a string to the given visible column width using string-width v8. */
function padToWidth(s: string, width: number): string {
  const current = stringWidth(s);
  return current >= width ? s : s + " ".repeat(width - current);
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Piece =
  | { kind: "sgr"; value: string; width: 0 }
  | { kind: "text"; value: string; width: number; space: boolean };

/**
 * Split a styled string into SGR escapes and individual grapheme clusters, so
 * wrapping can count visible columns without ever cutting inside an escape
 * sequence or between the code points of a flag/ZWJ emoji.
 */
function toPieces(s: string): Piece[] {
  const pieces: Piece[] = [];
  const addText = (chunk: string) => {
    for (const { segment } of GRAPHEMES.segment(chunk)) {
      pieces.push({ kind: "text", value: segment, width: stringWidth(segment), space: /^\s+$/.test(segment) });
    }
  };
  const sgr = new RegExp(SGR_PATTERN, "g");
  let last = 0;
  for (let m = sgr.exec(s); m; m = sgr.exec(s)) {
    if (m.index > last) addText(s.slice(last, m.index));
    pieces.push({ kind: "sgr", value: m[0], width: 0 });
    last = sgr.lastIndex;
  }
  if (last < s.length) addText(s.slice(last));
  return pieces;
}

/** Fold an SGR sequence into the set of styles currently in effect. */
function applySgr(state: string[], seq: string): string[] {
  const params = seq.slice(2, -1);
  if (params === "" || /^0+$/.test(params)) return [];
  return [...state, seq];
}

/**
 * Word-wrap a possibly ANSI-styled string to `maxWidth` visible columns.
 *
 * Every line reopens the styles that were active at the break and closes them
 * again at the end, so a wrap never splits an escape sequence and colour never
 * bleeds into the table border. Tokens wider than the column are hard-broken on
 * a grapheme boundary at the column limit, whether or not they start the line.
 */
export function wrapStyled(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  if (stringWidth(text) <= maxWidth) return [text];

  const lines: string[] = [];
  let open: string[] = [];
  let line: Piece[] = [];
  let width = 0;
  let lastSpace = -1; // index in `line` of the first piece of the trailing space run

  /** Emit `line[0..cut)` as a finished line and continue from `resume`. */
  const emit = (cut: number, resume: number) => {
    const body = line.slice(0, cut).map((p) => p.value).join("");
    lines.push(body.length > 0 && (open.length > 0 || body.includes("\x1b")) ? open.join("") + body + RESET : body);
    open = line.slice(0, resume).reduce((st, p) => (p.kind === "sgr" ? applySgr(st, p.value) : st), open);
    line = line.slice(resume);
    width = line.reduce((w, p) => w + p.width, 0);
    lastSpace = -1;
  };

  for (const piece of toPieces(text)) {
    if (piece.kind === "sgr") {
      line.push(piece);
      continue;
    }
    if (width + piece.width > maxWidth && width > 0) {
      if (piece.space) {
        // Break right here and swallow the space that caused the overflow.
        emit(line.length, line.length);
        continue;
      }
      if (lastSpace >= 0) {
        // Break at the last word boundary, dropping the space run itself.
        let resume = lastSpace;
        while (resume < line.length && line[resume]!.kind === "text" && (line[resume] as any).space) resume++;
        emit(lastSpace, resume);
      } else {
        // Token wider than the column — hard break at the grapheme boundary.
        emit(line.length, line.length);
      }
    }
    if (piece.space && width === 0) continue; // no leading spaces on a wrapped line
    lastSpace = piece.space ? (lastSpace < 0 ? line.length : lastSpace) : -1;
    line.push(piece);
    width += piece.width;
  }

  if (line.length > 0) {
    const cut = lastSpace >= 0 ? lastSpace : line.length;
    emit(cut, line.length);
  }
  return lines.length > 0 ? lines : [""];
}

function extractCells(token: any): { headers: string[]; rows: string[][] } {
  const headers: string[] = (token.header ?? []).map((h: any) =>
    stripVariationSelectors((h.tokens ?? []).map(renderInlineToken).join("").trim())
  );
  const rows: string[][] = (token.rows ?? []).map((row: any) =>
    row.map((cell: any) =>
      stripVariationSelectors((cell.tokens ?? []).map(renderInlineToken).join("").trim())
    )
  );
  return { headers, rows };
}

/**
 * Choose column widths that always sum to at most `available`.
 *
 * Columns narrower than their fair share keep their natural width and donate
 * the remainder to the wider ones. The `minCol` floor is capped by the fair
 * share so it can never push the table past the terminal edge, and a final
 * shave pass guarantees the invariant even in degenerate cases.
 */
export function fitColumns(naturalWidths: number[], available: number): number[] {
  const colCount = naturalWidths.length;
  if (colCount === 0) return [];
  if (available < colCount) return naturalWidths.map(() => 1);

  const total = naturalWidths.reduce((a, b) => a + b, 0);
  if (total <= available) return [...naturalWidths];

  const minCol = Math.max(1, Math.min(6, Math.floor(available / colCount)));
  const order = naturalWidths.map((w, i) => ({ w, i })).sort((a, b) => a.w - b.w);
  const widths = [...naturalWidths];
  let remaining = available;
  let flex = colCount;
  for (const { w, i } of order) {
    const share = Math.floor(remaining / flex);
    widths[i] = w <= share ? w : Math.max(minCol, share);
    remaining -= widths[i]!;
    flex--;
  }

  // Shave the widest columns back if the floor overshot, then hand any slack
  // to the widest column so the table lines up flush.
  let overflow = widths.reduce((a, b) => a + b, 0) - available;
  for (let k = order.length - 1; k >= 0 && overflow > 0; k--) {
    const i = order[k]!.i;
    const take = Math.min(overflow, widths[i]! - 1);
    widths[i]! -= take;
    overflow -= take;
  }
  const slack = available - widths.reduce((a, b) => a + b, 0);
  if (slack > 0) widths[order[order.length - 1]!.i]! += slack;
  return widths;
}

/**
 * Render a table using unicode box-drawing characters with string-width v8
 * for accurate column padding across all scripts and emoji.
 */
function renderUnicodeTable(headers: string[], rows: string[][], colWidths: number[]): string {
  function hLine(left: string, mid: string, right: string, fill: string): string {
    return left + colWidths.map((w) => fill.repeat(w + 2)).join(mid) + right;
  }

  function dataLine(cells: string[]): string {
    const wrapped = colWidths.map((w, i) => wrapStyled(cells[i] ?? "", w));
    const height = Math.max(1, ...wrapped.map((wc) => wc.length));

    const out: string[] = [];
    for (let line = 0; line < height; line++) {
      const parts = wrapped.map((wc, i) => " " + padToWidth(wc[line] ?? "", colWidths[i]!) + " ");
      out.push("│" + parts.join("│") + "│");
    }
    return out.join("\n");
  }

  const lines: string[] = [];
  lines.push(hLine("┌", "┬", "┐", "─"));
  lines.push(dataLine(headers.map((h) => chalk.bold(h))));
  lines.push(hLine("├", "┼", "┤", "─"));
  for (const row of rows) lines.push(dataLine(row));
  lines.push(hLine("└", "┴", "┘", "─"));

  return "\n" + lines.join("\n") + "\n\n";
}

function makeTableExtension(termWidth: number) {
  return {
    name: "table",
    renderer(token: any): string {
      const { headers, rows } = extractCells(token);
      const colCount = headers.length;
      if (colCount === 0) return "";

      // Measure visible widths using string-width v8 — accurate for CJK,
      // emoji, Devanagari combining marks, flag sequences, etc.
      const allRows = [headers, ...rows].map((r) => r.map(stripAnsi));
      const naturalWidths = Array(colCount).fill(0) as number[];
      for (const row of allRows) {
        for (let i = 0; i < colCount; i++) {
          naturalWidths[i] = Math.max(naturalWidths[i]!, stringWidth(row[i] ?? ""));
        }
      }

      // borders: colCount + 1 │ chars, padding: 1 space each side per column
      const overhead = (colCount + 1) + (colCount * 2);
      return renderUnicodeTable(headers, rows, fitColumns(naturalWidths, termWidth - overhead));
    },
  };
}

/**
 * marked is configured with a fixed wrap width, so rebuild the instance when
 * the terminal is resized rather than baking the startup width in for good.
 */
let cachedWidth = -1;
let cachedMarked: Marked | null = null;

function getMarked(): Marked {
  const width = currentWidth();
  if (cachedMarked && cachedWidth === width) return cachedMarked;
  const instance = new Marked();
  instance.use({ extensions: [makeTableExtension(width)] });
  instance.use(markedTerminal({
    reflowText: true,
    width,
    heading: (text: string) => "\n" + chalk.bold.cyan(text) + "\n",
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.bold.yellow,
    code: chalk.yellow,
    listitem: (s: string) => s,
  }) as any);
  cachedWidth = width;
  cachedMarked = instance;
  return instance;
}

// Box-drawing characters used by the table renderer that must survive post-processing.
const BOX_DRAWING_RE = /[┌┐└┘├┤┬┴┼─│╔╗╚╝╠╣╦╩╬═║]/;

const _markdownCache = new Map<string, string>();
const MARKDOWN_CACHE_MAX = 300;

/** Renders markdown into terminal-friendly styled text. */
export function renderMarkdown(text: string): string {
  const width = process.stdout.columns || 80;
  const cacheKey = `${width}:${text}`;
  const cached = _markdownCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const result = getMarked().parse(text);
    if (typeof result !== "string") return text;
    let cleaned = result.replace(/\n+$/, "");
    cleaned = cleaned.replace(/^(\s*)\* /gm, "$1• ");
    const lines = cleaned.split("\n").map((line) => {
      // Skip lines containing box-drawing characters (table borders/rows) —
      // the bold/italic/code regexes would corrupt column alignment.
      const stripped = stripAnsi(line);
      if (BOX_DRAWING_RE.test(stripped)) return line;

      const headingMatch = stripped.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        return "\n" + chalk.bold.cyan(headingMatch[2]!);
      }
      return line
        .replace(/\*\*([^*]+)\*\*/g, (_match, bold) => chalk.bold(bold))
        .replace(/\*([^*]+)\*/g, (_match, em) => chalk.italic(em))
        .replace(/`([^`]+)`/g, (_match, code) => chalk.bold.yellow(code));
    });
    const output = lines.join("\n");
    if (_markdownCache.size >= MARKDOWN_CACHE_MAX) {
      // Evict oldest entry
      const firstKey = _markdownCache.keys().next().value;
      if (firstKey !== undefined) _markdownCache.delete(firstKey);
    }
    _markdownCache.set(cacheKey, output);
    return output;
  } catch {
    return text;
  }
}

interface Props {
  children: string;
}

/** Displays markdown content inside an Ink Text node. */
export default function MarkdownText({ children }: Props) {
  return <Text>{renderMarkdown(children)}</Text>;
}
