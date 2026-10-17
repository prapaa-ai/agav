import { describe, expect, it } from "vitest";
import { advanceVoiceDraft } from "../utils/voice-draft.js";

describe("stable cumulative speech drafts", () => {
  it.each(["", "   ", "explain", "explain parser", "unrelated replacement", "totally rewritten longer hypothesis"])("retains accepted words for non-extending hypothesis %j", next => {
    expect(advanceVoiceDraft("explain parser", next)).toEqual({ accepted: "explain parser", suffix: "" });
  });
  it("rebases corrected hypotheses so later speech cannot be blocked forever", () => {
    let baseline = "explain par sir";
    let visible = baseline;
    for (const hypothesis of ["explain parser", "explain parser carefully", "explain parser carefully add tests"]) {
      const next = advanceVoiceDraft(baseline, hypothesis);
      baseline = next.accepted;
      if (next.suffix) visible += " " + next.suffix;
    }
    expect(visible).toBe("explain par sir carefully add tests");
  });
  it("recovers when the recognizer revises the first word but retains a speech anchor", () => {
    const corrected = advanceVoiceDraft("a parser", "the parser");
    expect(corrected.suffix).toBe("");
    expect(advanceVoiceDraft(corrected.accepted, "the parser needs tests").suffix).toBe("needs tests");
  });
  it("accepts initial speech and adds only new trailing words", () => {
    expect(advanceVoiceDraft("", "  explain parser ")).toEqual({ accepted: "explain parser", suffix: "explain parser" });
    expect(advanceVoiceDraft("explain parser", "explain parser carefully")).toEqual({ accepted: "explain parser carefully", suffix: "carefully" });
  });
  it("preserves intentional repetitions without duplicating replayed hypotheses", () => {
    const initial = advanceVoiceDraft("", "go go");
    expect(advanceVoiceDraft(initial.accepted, "go go").suffix).toBe("");
    expect(advanceVoiceDraft(initial.accepted, "go go go")).toEqual({ accepted: "go go go", suffix: "go" });
  });
  it("matches case/punctuation changes without replacing accepted wording", () => {
    expect(advanceVoiceDraft("Explain parser!", "explain parser carefully.")).toEqual({ accepted: "Explain parser! carefully.", suffix: "carefully." });
  });
  it("does not commit unmatched rewritten prefixes, then accepts a returning cumulative extension", () => {
    let accepted = "explain parser";
    for (const revision of ["", "explain", "show the parser in detail"]) {
      const next = advanceVoiceDraft(accepted, revision);
      expect(next.suffix).toBe(""); accepted = next.accepted;
    }
    expect(advanceVoiceDraft(accepted, "explain parser in detail")).toEqual({ accepted: "explain parser in detail", suffix: "in detail" });
  });
  it("does not append inserted prefix words when previously accepted words still appear in order", () => {
    expect(advanceVoiceDraft("explain parser", "please explain the parser carefully")).toEqual({ accepted: "explain parser carefully", suffix: "carefully" });
  });
});
