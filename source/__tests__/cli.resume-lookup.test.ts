import { describe, expect, it } from "vitest";
import { resolveResumeLookup } from "../main.js";

describe("cli/resume lookup", () => {
  it("returns not_found when an explicit ID is given with empty history", () => {
    expect(resolveResumeLookup([], "missing-id")).toEqual({
      kind: "not_found",
      prefix: "missing-id",
    });
  });

  it("preserves exact, unique-prefix, and ambiguous lookup behavior", () => {
    const sessions = [{ id: "abc123" }, { id: "abc456" }, { id: "xyz999" }];

    expect(resolveResumeLookup(sessions, "abc123")).toEqual({
      kind: "match",
      session: { id: "abc123" },
    });
    expect(resolveResumeLookup(sessions, "xyz")).toEqual({
      kind: "match",
      session: { id: "xyz999" },
    });
    expect(resolveResumeLookup(sessions, "abc")).toEqual({
      kind: "ambiguous",
      prefix: "abc",
    });
    expect(resolveResumeLookup(sessions, "none")).toEqual({
      kind: "not_found",
      prefix: "none",
    });
  });
});
