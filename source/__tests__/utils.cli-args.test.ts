import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { parseMaxTurns } from "../utils/cli-args.js";

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe("utils/cli-args parseMaxTurns", () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    // Throw instead of exiting so the test stops where the real process would.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ExitCalled(code);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stderrOutput = () => stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");

  it.each([
    ["5", 5],
    [" 5 ", 5],
    ["1", 1],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("accepts %j and returns %d", (raw, expected) => {
    expect(parseMaxTurns(raw)).toBe(expected);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "0", "-1", "5e2", "+5", "abc", "1.5", "0x10", "9007199254740992"])(
    "rejects %j with an error and exit code 1",
    (raw) => {
      expect(() => parseMaxTurns(raw)).toThrow(ExitCalled);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrOutput()).toContain("Error: --max-turns must be a plain positive integer (digits only");
    },
  );

  it.each(["5e2", "+5", "0x10", "1.5"])("echoes the rejected value %j so the digits-only rule is clear", (raw) => {
    expect(() => parseMaxTurns(raw)).toThrow(ExitCalled);
    expect(stderrOutput()).toContain(`(digits only, 1–9007199254740991), got ${JSON.stringify(raw)}.`);
  });

  it("uses the default flag name in the usage hint", () => {
    expect(() => parseMaxTurns("abc")).toThrow(ExitCalled);
    expect(stderrOutput()).toContain("Use --max-turns N or --max-turns=N.");
  });

  it("includes a custom flag and usage in the message", () => {
    expect(() => parseMaxTurns("0", "-c maxIterations", "Use -c maxIterations=N.")).toThrow(ExitCalled);
    const out = stderrOutput();
    expect(out).toContain("Error: -c maxIterations must be a plain positive integer (digits only");
    expect(out).toContain("Use -c maxIterations=N.");
    expect(out).not.toContain("--max-turns");
  });

  it("derives the default usage from a custom flag", () => {
    expect(() => parseMaxTurns("x", "--budget")).toThrow(ExitCalled);
    expect(stderrOutput()).toContain("Use --budget N or --budget=N.");
  });
});
