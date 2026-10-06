 import { describe, it, expect } from "vitest";

  function validateMaxTurns(raw?: string) {
    if (!raw) return undefined;
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(n) || n <= 0) throw new Error("invalid");
    return n;
  }

  describe("--max-turns CLI validation", () => {
    it("rejects zero", () => {
      expect(() => validateMaxTurns("0")).toThrow();
    });
    it("rejects negative", () => {
      expect(() => validateMaxTurns("-5")).toThrow();
    });
    it("rejects non-numeric", () => {
      expect(() => validateMaxTurns("foo")).toThrow();
    });
    it("accepts positive integer", () => {
      expect(validateMaxTurns("10")).toBe(10);
    });
  });