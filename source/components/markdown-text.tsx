import React from "react";
import { Text } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

import chalk from "chalk";

const termWidth = process.stdout.columns ? process.stdout.columns - 4 : 80;

function extractCells(token: any): { headers: string[]; rows: string[][] } {
  const headers: string[] = (token.header ?? []).map((h: any) =>
    (h.tokens ?? []).map((t: any) => t.raw ?? t.text ?? "").join("").trim()
  );
  const rows: string[][] = (token.rows ?? []).map((row: any) =>
    row.map((cell: any) =>
      (cell.tokens ?? []).map((t: any) => t.raw ?? t.text ?? "").join("").trim()
    )
  );
  return { headers, rows };
}

function renderResponsiveTable(headers: string[], rows: string[][]): string {
  const colCount = headers.length;
  const allRows = [headers, ...rows];
  const naturalWidths = Array(colCount).fill(0) as number[];
  for (const row of allRows) {
    for (let i = 0; i < colCount; i++) {
      naturalWidths[i] = Math.max(naturalWidths[i]!, (row[i] ?? "").length);
    }
  }

  const overhead = (colCount * 3) + 1; // "| " per col + final "|"
  const available = termWidth - overhead;
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);

  let colWidths: number[];
  if (totalNatural <= available) {
    colWidths = naturalWidths;
  } else {
    const minCol = 8;
    colWidths = naturalWidths.map((w) => Math.max(minCol, Math.floor((w / totalNatural) * available)));
    const used = colWidths.reduce((a, b) => a + b, 0);
    if (used < available) colWidths[colWidths.length - 1]! += available - used;
  }

  function padCell(text: string, width: number): string {
    if (text.length > width) return text.slice(0, width - 1) + "~";
    return text.padEnd(width);
  }

  function drawRow(cells: string[]): string {
    return "| " + cells.map((c, i) => padCell(c, colWidths[i]!)).join(" | ") + " |";
  }

  function drawSep(): string {
    return "|-" + colWidths.map((w) => "-".repeat(w)).join("-|-") + "-|";
  }

  const lines: string[] = [];
  lines.push(drawRow(headers));
  lines.push(drawSep());
  for (const row of rows) {
    lines.push(drawRow(row));
  }
  return "\n" + lines.join("\n") + "\n";
}

const tableExtension = {
  name: "table",
  renderer(token: any): string {
    const { headers, rows } = extractCells(token);
    const colCount = headers.length;
    const allRows = [headers, ...rows];
    const naturalWidths = Array(colCount).fill(0) as number[];
    for (const row of allRows) {
      for (let i = 0; i < colCount; i++) {
        naturalWidths[i] = Math.max(naturalWidths[i]!, (row[i] ?? "").length);
      }
    }
    const overhead = (colCount * 3) + 1;
    const tableWidth = naturalWidths.reduce((a, b) => a + b, 0) + overhead;

    if (tableWidth > termWidth) {
      return renderResponsiveTable(headers, rows);
    }

    return false as any;
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

/** Renders markdown into terminal-friendly styled text. */
export function renderMarkdown(text: string): string {
  try {
    const result = marked.parse(text);
    if (typeof result !== "string") return text;
    let cleaned = result.replace(/\n+$/, "");
    cleaned = cleaned.replace(/^(\s*)\* /gm, "$1• ");
    cleaned = cleaned.replace(/\x1b\[[0-9;]*m/g, (m) => m);
    const lines = cleaned.split("\n").map((line) => {
      const headingMatch = line.replace(/\x1b\[[0-9;]*m/g, "").match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        return "\n" + chalk.bold.cyan(headingMatch[2]!);
      }
      return line;
    });
    return lines.join("\n")
      .replace(/\*\*([^*]+)\*\*/g, (_match, bold) => chalk.bold(bold))
      .replace(/\*([^*]+)\*/g, (_match, em) => chalk.italic(em))
      .replace(/`([^`]+)`/g, (_match, code) => chalk.bold.yellow(code));
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
