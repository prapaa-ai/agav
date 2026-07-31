import { describe, it, expect } from "vitest";

import { resetAttachmentCounter, createTextAttachment, isLargeText } from "../utils/attachments.js";

describe("utils/attachments", () => {
  it("creates numbered text attachments with size labels", () => {
    resetAttachmentCounter();
    const att1 = createTextAttachment("one\ntwo");
    const att2 = createTextAttachment("x".repeat(1000));

    expect(att1.id).toBe(1);
    expect(att1.type).toBe("text");
    expect(att1.label).toContain("Pasted #1");
    expect(att1.label).toContain("7 chars and 2 lines");
    expect(att2.id).toBe(2);
    expect(att2.label).toContain("1k chars");
  });

  it("detects large text by length and line count", () => {
    expect(isLargeText("a".repeat(501))).toBe(true);
    expect(isLargeText(Array.from({ length: 11 }, () => "x").join("\n"))).toBe(true);
    expect(isLargeText("small\ntext")).toBe(false);
  });
});
