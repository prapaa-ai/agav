import React from "react";
import { Text } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import stringWidth from "string-width";

const termWidth = process.stdout.columns ? process.stdout.columns - 4 : 80;

/** Render a single inline token to styled terminal text. */
function renderInlineToken(t: any): string {
  const text = t.text ?? t.raw ?? "";
  switch (t.type) {
    case "codespan": return chalk.bold.yellow(text);
    case "strong": return chalk.bold(text);
    case "em": return chalk.italic(text);
    case "del": return chalk.strikethrough(text);
    case "link": return t.title ? `${chalk.underline.blue(text)} (${t.href})` : chalk.underline.blue(text);
    default: return text;
  }
}

/** Strip ANSI escape sequences to get the visible text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Strip Unicode variation selectors that cause width measurement
 * inconsistencies across string-width versions and terminals.
 */
function stripVariationSelectors(s: string): string {
  return s.replace(/[\uFE0E\uFE0F]/g, "");
}

/** Pad a string to the given visible column width using string-width v8. */
function padToWidth(s: string, width: number): string {
  const current = stringWidth(s);
  return current >= width ? s : s + " ".repeat(width - current);
}

/**
 * Word-wrap text to fit within a given column width, breaking on word
 * boundaries when possible.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (stringWidth(text) <= maxWidth) return [text];
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current + word;
    if (stringWidth(candidate) <= maxWidth) {
      current = candidate;
    } else if (current.trim()) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      // Single word wider than maxWidth — hard break
      lines.push(word.slice(0, maxWidth));
      current = word.slice(maxWidth);
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
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
 * Render a table using unicode box-drawing characters with string-width v8
 * for accurate column padding across all scripts and emoji.
 */
function renderUnicodeTable(headers: string[], rows: string[][], colWidths: number[]): string {
  const colCount = headers.length;

  function hLine(left: string, mid: string, right: string, fill: string): string {
    return left + colWidths.map((w) => fill.repeat(w + 2)).join(mid) + right;
  }

  function dataLine(cells: string[]): string {
    // Wrap each cell's content to fit its column width
    const wrappedCells = cells.map((cell, i) => wrapText(cell, colWidths[i]!));
    const maxLines = Math.max(1, ...wrappedCells.map((wc) => wc.length));

    const outputLines: string[] = [];
    for (let line = 0; line < maxLines; line++) {
      const parts = wrappedCells.map((wc, i) => {
        const text = wc[line] ?? "";
        return " " + padToWidth(text, colWidths[i]!) + " ";
      });
      outputLines.push("│" + parts.join("│") + "│");
    }
    return outputLines.join("\n");
  }

  const lines: string[] = [];
  lines.push(hLine("┌", "┬", "┐", "─"));
  lines.push(dataLine(headers.map((h) => chalk.bold(h))));
  lines.push(hLine("├", "┼", "┤", "─"));
  for (let i = 0; i < rows.length; i++) {
    lines.push(dataLine(rows[i]!));
    if (i < rows.length - 1) lines.push(hLine("├", "┼", "┤", "─"));
  }
  lines.push(hLine("└", "┴", "┘", "─"));

  return "\n" + lines.join("\n") + "\n\n";
}

const tableExtension = {
  name: "table",
  renderer(token: any): string {
    const { headers, rows } = extractCells(token);
    const colCount = headers.length;
    if (colCount === 0) return "";

    // Measure visible widths using string-width v8 — accurate for CJK,
    // emoji, Devanagari combining marks, flag sequences, etc.
    const allRows = [headers.map(stripAnsi), ...rows.map((r) => r.map(stripAnsi))];
    const naturalWidths = Array(colCount).fill(0) as number[];
    for (const row of allRows) {
      for (let i = 0; i < colCount; i++) {
        naturalWidths[i] = Math.max(naturalWidths[i]!, stringWidth(row[i] ?? ""));
      }
    }

    // borders: colCount + 1 │ chars, padding: 1 space each side per column
    const overhead = (colCount + 1) + (colCount * 2);
    const available = termWidth - overhead;
    const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);

    let colWidths: number[];
    if (totalNatural <= available) {
      colWidths = naturalWidths;
    } else {
      // Shrink columns to fit: keep short columns at natural width when
      // possible and absorb the reduction from the widest columns.
      const minCol = 6;
      const sorted = naturalWidths.map((w, i) => ({ w, i })).sort((a, b) => a.w - b.w);
      colWidths = [...naturalWidths];
      let remaining = available;
      let flexCols = colCount;

      for (const { w, i } of sorted) {
        const share = Math.floor(remaining / flexCols);
        if (w <= share) {
          // Column fits within its fair share — keep natural width
          colWidths[i] = w;
          remaining -= w;
        } else {
          // Column too wide — give it a fair share (at least minCol)
          colWidths[i] = Math.max(minCol, share);
          remaining -= colWidths[i]!;
        }
        flexCols--;
      }
      // Distribute any leftover to the last (widest) column
      const totalUsed = colWidths.reduce((a, b) => a + b, 0);
      if (totalUsed < available) {
        const widest = sorted[sorted.length - 1]!.i;
        colWidths[widest]! += available - totalUsed;
      }
    }

    return renderUnicodeTable(headers, rows, colWidths);
  },
};

marked.use({ extensions: [tableExtension] });

marked.use(markedTerminal({
  reflowText: true,
  width: termWidth,
  heading: (text: string) => "\n" + chalk.bold.cyan(text) + "\n",
  strong: chalk.bold,
  em: chalk.italic,
  codespan: chalk.bold.yellow,
  code: chalk.yellow,
  listitem: (s: string) => s,
}) as any);

// Box-drawing characters used by the table renderer that must survive post-processing.
const BOX_DRAWING_RE = /[┌┐└┘├┤┬┴┼─│╔╗╚╝╠╣╦╩╬═║]/;

/** Renders markdown into terminal-friendly styled text. */
export function renderMarkdown(text: string): string {
  try {
    const result = marked.parse(text);
    if (typeof result !== "string") return text;
    let cleaned = result.replace(/\n+$/, "");
    cleaned = cleaned.replace(/^(\s*)\* /gm, "$1• ");
    cleaned = cleaned.replace(/\x1b\[[0-9;]*m/g, (m) => m);
    const lines = cleaned.split("\n").map((line) => {
      // Skip lines containing box-drawing characters (table borders/rows) —
      // the bold/italic/code regexes would corrupt column alignment.
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
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
    return lines.join("\n");
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
