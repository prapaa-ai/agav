import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_WAIT_MS, formatDiagnostics } from "../tools/lsp.js";

const diag = (overrides: Record<string, unknown> = {}) => ({
  severity: 1,
  message: "cannot find name 'x'",
  range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
  ...overrides,
});

describe("formatDiagnostics", () => {
  it("renders one-based ranges, severity and message", () => {
    expect(formatDiagnostics([diag()])).toEqual(["3:5-3:10  error  cannot find name 'x'"]);
  });

  it.each([[1, "error"], [2, "warning"], [3, "information"], [4, "hint"], [undefined, "diagnostic"]])(
    "names severity %s",
    (severity, name) => {
      expect(formatDiagnostics([diag({ severity })])[0]).toContain(`  ${name}  `);
    },
  );

  it("sorts by position and keeps the source", () => {
    const rows = formatDiagnostics([
      diag({ message: "second", range: { start: { line: 9, character: 1 }, end: { line: 9, character: 2 } } }),
      diag({ message: "first", source: "ts", range: { start: { line: 1, character: 3 }, end: { line: 1, character: 4 } } }),
    ]);
    expect(rows).toEqual([
      "2:4-2:5  error  first (ts)",
      "10:2-10:3  error  second",
    ]);
  });

  it("collapses whitespace and skips entries without a message or range", () => {
    expect(formatDiagnostics([
      diag({ message: "  bad\n  indentation  " }),
      { message: "", range: diag().range },
      "nonsense",
      null,
    ])).toEqual(["3:5-3:10  error  bad indentation"]);
  });

  it("falls back to 1:1 for a diagnostic with no range", () => {
    expect(formatDiagnostics([{ message: "no range" }])).toEqual(["1:1-1:1  diagnostic  no range"]);
  });

  it("waits a bounded three seconds", () => {
    expect(DIAGNOSTIC_WAIT_MS).toBe(3_000);
  });
});
