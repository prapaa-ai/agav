import { describe, expect, it } from "vitest";

import {
  applyVerbositySteering,
  resolveTurnEffort,
  inspectLastToolResults,
  VERBOSITY_STEER_NOTE,
} from "../agent/output-reduction.js";
import type { ContentBlock, Message } from "../providers/types.js";

describe("verbosity steering", () => {
  it("appends the note to the end of the system prompt", () => {
    const out = applyVerbositySteering("You are a coding agent.");
    expect(out.startsWith("You are a coding agent.")).toBe(true); // prefix stable → cache-safe
    expect(out.endsWith(VERBOSITY_STEER_NOTE)).toBe(true);
  });

  it("handles an undefined system prompt", () => {
    const out = applyVerbositySteering(undefined);
    expect(out).toBe(VERBOSITY_STEER_NOTE);
  });

  it("is idempotent — never appends twice", () => {
    const once = applyVerbositySteering("base");
    const twice = applyVerbositySteering(once);
    expect(twice).toBe(once);
  });
});

describe("resolveTurnEffort", () => {
  it("keeps configured effort on a fresh (non-resume) turn", () => {
    expect(resolveTurnEffort("high", { isResumeTurn: false, lastToolOutputHadError: false })).toBe("high");
  });

  it("lowers effort one notch on a clean resume turn", () => {
    expect(resolveTurnEffort("high", { isResumeTurn: true, lastToolOutputHadError: false })).toBe("medium");
    expect(resolveTurnEffort("max", { isResumeTurn: true, lastToolOutputHadError: false })).toBe("high");
    expect(resolveTurnEffort("medium", { isResumeTurn: true, lastToolOutputHadError: false })).toBe("low");
  });

  it("never lowers below low", () => {
    expect(resolveTurnEffort("low", { isResumeTurn: true, lastToolOutputHadError: false })).toBe("low");
  });

  it("keeps full effort when the last tool output had an error", () => {
    expect(resolveTurnEffort("high", { isResumeTurn: true, lastToolOutputHadError: true })).toBe("high");
  });

  it("passes through undefined effort", () => {
    expect(resolveTurnEffort(undefined, { isResumeTurn: true, lastToolOutputHadError: false })).toBeUndefined();
  });
});

describe("inspectLastToolResults", () => {
  const userText = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] });
  const toolResults = (blocks: ContentBlock[]): Message => ({ role: "user", content: blocks });

  it("detects a resume turn with clean results", () => {
    const r = inspectLastToolResults([
      userText("do it"),
      { role: "assistant", content: [{ type: "tool_use", toolCallId: "c1", toolName: "read_file" }] },
      toolResults([{ type: "tool_result", toolCallId: "c1", toolResult: "ok" }]),
    ]);
    expect(r).toEqual({ isResumeTurn: true, hadError: false });
  });

  it("flags an error in the latest tool results", () => {
    const r = inspectLastToolResults([
      toolResults([{ type: "tool_result", toolCallId: "c1", toolResult: "boom", isError: true }]),
    ]);
    expect(r).toEqual({ isResumeTurn: true, hadError: true });
  });

  it("is not a resume turn when the last message is plain user text", () => {
    const r = inspectLastToolResults([userText("hello")]);
    expect(r).toEqual({ isResumeTurn: false, hadError: false });
  });

  it("handles an empty conversation", () => {
    expect(inspectLastToolResults([])).toEqual({ isResumeTurn: false, hadError: false });
  });
});
