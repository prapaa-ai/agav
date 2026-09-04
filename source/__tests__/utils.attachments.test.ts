import { describe, it, expect } from "vitest";

import {
  resetAttachmentCounter,
  createTextAttachment,
  createImageAttachmentFromData,
  createFileAttachment,
  isLargeText,
  ATTACHMENT_TILE_RE,
  attachmentTileScanner,
} from "../utils/attachments.js";
import { getAttachment, clearAttachmentRegistry, wasEvicted } from "../utils/attachment-registry.js";

describe("utils/attachments", () => {
  it("creates numbered text attachments with size labels", () => {
    resetAttachmentCounter();
    const att1 = createTextAttachment("one\ntwo");
    const att2 = createTextAttachment("x".repeat(1000));

    expect(att1.id).toBe(1);
    expect(att1.kind).toBe("paste");
    expect(att1.label).toContain("Pasted #1");
    expect(att1.label).toContain("7 chars, 2 lines");
    expect(att2.id).toBe(2);
    expect(att2.label).toContain("1k chars");
  });

  it("detects large text by length and line count", () => {
    expect(isLargeText("a".repeat(501))).toBe(true);
    expect(isLargeText(Array.from({ length: 11 }, () => "x").join("\n"))).toBe(true);
    expect(isLargeText("small\ntext")).toBe(false);
  });

  it("registers every attachment under the shared session-unique id source", () => {
    resetAttachmentCounter();
    clearAttachmentRegistry();
    const paste = createTextAttachment("hello");
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);
    const file = createFileAttachment("/abs/src/app.ts", "src/app.ts");

    expect(paste.id).not.toBe(image.id);
    expect(image.id).not.toBe(file.id);
    expect(getAttachment(paste.id)).toBe(paste);
    expect(getAttachment(image.id)).toBe(image);
    expect(getAttachment(file.id)).toBe(file);
  });

  it("builds labels in the `<<Kind #id · summary>>` grammar", () => {
    resetAttachmentCounter();
    const paste = createTextAttachment("x".repeat(20));
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);
    const file = createFileAttachment("/abs/src/app.ts", "src/app.ts");

    expect(paste.label).toMatch(/^<<Pasted #\d+ · .+>>$/);
    expect(image.label).toMatch(/^<<Image #\d+ · 800x600>>$/);
    expect(file.label).toMatch(/^<<File #\d+ · src\/app\.ts>>$/);
  });

  it("substitutes '>' in a summary so a tile can never run past its own delimiter", () => {
    resetAttachmentCounter();
    const file = createFileAttachment("/abs/weird>name.ts", "weird>name.ts");
    expect(file.label).not.toMatch(/weird>name\.ts/);
    expect(file.label).toContain("weird?name.ts");
    // And the tile still matches as a single, well-formed unit.
    expect(ATTACHMENT_TILE_RE.test(file.label)).toBe(true);
  });
});

describe("ATTACHMENT_TILE_RE / attachmentTileScanner", () => {
  it("matches all three kinds", () => {
    expect(ATTACHMENT_TILE_RE.test("<<Pasted #1 · 2k chars, 40 lines>>")).toBe(true);
    expect(ATTACHMENT_TILE_RE.test("<<Image #2 · 800x600>>")).toBe(true);
    expect(ATTACHMENT_TILE_RE.test("<<File #3 · src/app.ts>>")).toBe(true);
  });

  it("does not match a malformed tile", () => {
    expect(ATTACHMENT_TILE_RE.test("<<Pasted 2k chars>>")).toBe(false);
    expect(ATTACHMENT_TILE_RE.test("<<Weird #1 · foo>>")).toBe(false);
    expect(ATTACHMENT_TILE_RE.test("<<Pasted #1: 2k chars>>")).toBe(false);
  });

  it("matches two adjacent tiles separately", () => {
    const text = "<<Pasted #1 · a>><<Image #2 · b>>";
    const scanner = attachmentTileScanner();
    const matches = [...text.matchAll(scanner)];
    expect(matches).toHaveLength(2);
    expect(matches[0]![1]).toBe("1");
    expect(matches[1]![1]).toBe("2");
  });
});

describe("attachment registry eviction", () => {
  it("evicts the oldest record once the cap is exceeded and reports it as evicted", async () => {
    resetAttachmentCounter();
    clearAttachmentRegistry();
    const first = createTextAttachment("first");
    for (let i = 0; i < 200; i++) createTextAttachment(`filler-${i}`);

    expect(getAttachment(first.id)).toBeUndefined();
    expect(wasEvicted(first.id)).toBe(true);
  });
});
