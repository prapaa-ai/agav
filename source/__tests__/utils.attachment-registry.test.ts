import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../utils/open-external.js", () => ({
  spoolImageToTempFile: vi.fn(),
}));

import { spoolImageToTempFile } from "../utils/open-external.js";
import {
  getAttachment,
  clearAttachmentRegistry,
  listAttachments,
  compactImageAttachment,
  compactImageAttachments,
  unregisterAttachment,
  wasEvicted,
} from "../utils/attachment-registry.js";
import {
  resetAttachmentCounter,
  createTextAttachment,
  createImageAttachmentFromData,
  createFileAttachment,
} from "../utils/attachments.js";

const spoolMock = vi.mocked(spoolImageToTempFile);

describe("utils/attachment-registry: listAttachments", () => {
  beforeEach(() => {
    resetAttachmentCounter();
    clearAttachmentRegistry();
    vi.clearAllMocks();
  });

  it("returns an empty list when nothing is registered", () => {
    expect(listAttachments()).toEqual([]);
  });

  it("returns every registered attachment, oldest first", () => {
    const first = createTextAttachment("first");
    const second = createImageAttachmentFromData("YWJj", "image/png", 10, 10);
    const third = createFileAttachment("/abs/a.ts", "a.ts");

    expect(listAttachments()).toEqual([first, second, third]);
  });

  it("omits an attachment once it has been evicted", () => {
    const first = createTextAttachment("first");
    for (let i = 0; i < 200; i++) createTextAttachment(`filler-${i}`);

    const listed = listAttachments();
    expect(listed.find((a) => a.id === first.id)).toBeUndefined();
    expect(listed).toHaveLength(200);
  });
});

describe("utils/attachment-registry: unregisterAttachment", () => {
  beforeEach(() => {
    resetAttachmentCounter();
    clearAttachmentRegistry();
    vi.clearAllMocks();
  });

  it("removes the attachment so it can no longer be looked up", () => {
    const paste = createTextAttachment("hello world");
    expect(getAttachment(paste.id)).toBe(paste);

    unregisterAttachment(paste.id);

    expect(getAttachment(paste.id)).toBeUndefined();
  });

  it("does not mark the id as evicted — it was forgotten, not lost to a cap", () => {
    const paste = createTextAttachment("hello world");
    unregisterAttachment(paste.id);
    expect(wasEvicted(paste.id)).toBe(false);
  });

  it("removes it from listAttachments without disturbing the order of the rest", () => {
    const first = createTextAttachment("first");
    const second = createTextAttachment("second");
    const third = createTextAttachment("third");

    unregisterAttachment(second.id);

    expect(listAttachments()).toEqual([first, third]);
  });

  it("is a no-op for an id that was never registered", () => {
    expect(() => unregisterAttachment(999999)).not.toThrow();
    expect(listAttachments()).toEqual([]);
  });
});

describe("utils/attachment-registry: compactImageAttachment", () => {
  beforeEach(() => {
    resetAttachmentCounter();
    clearAttachmentRegistry();
    vi.clearAllMocks();
  });

  it("spools base64 to a temp file and drops the base64 copy, keeping spoolPath", async () => {
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);
    spoolMock.mockResolvedValue("/tmp/agav-images/spooled-1.png");

    await compactImageAttachment(image.id);

    expect(spoolMock).toHaveBeenCalledWith("YWJj", "image/png");
    const stored = getAttachment(image.id)!;
    expect(stored.source).toMatchObject({ type: "image", spoolPath: "/tmp/agav-images/spooled-1.png" });
    expect((stored.source as any).base64).toBeUndefined();
  });

  it("is a no-op when the attachment already has a spoolPath", async () => {
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);
    const stored = getAttachment(image.id)!;
    (stored.source as any).spoolPath = "/already/spooled.png";

    await compactImageAttachment(image.id);

    expect(spoolMock).not.toHaveBeenCalled();
    expect((getAttachment(image.id)!.source as any).spoolPath).toBe("/already/spooled.png");
  });

  it("is a no-op when there is no base64 data to spool", async () => {
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);
    const stored = getAttachment(image.id)!;
    (stored.source as any).base64 = undefined;

    await compactImageAttachment(image.id);

    expect(spoolMock).not.toHaveBeenCalled();
  });

  it("is a no-op for a nonexistent attachment id", async () => {
    await expect(compactImageAttachment(123456)).resolves.toBeUndefined();
    expect(spoolMock).not.toHaveBeenCalled();
  });

  it("is a no-op for a non-image attachment", async () => {
    const paste = createTextAttachment("hello");
    await compactImageAttachment(paste.id);
    expect(spoolMock).not.toHaveBeenCalled();
    expect(getAttachment(paste.id)!.source).toEqual({ type: "text", text: "hello" });
  });

  it("leaves the base64 in place if spooling fails", async () => {
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);
    spoolMock.mockRejectedValue(new Error("disk full"));

    await expect(compactImageAttachment(image.id)).resolves.toBeUndefined();

    const stored = getAttachment(image.id)!;
    expect((stored.source as any).base64).toBe("YWJj");
    expect((stored.source as any).spoolPath).toBeUndefined();
  });
});

describe("utils/attachment-registry: compactImageAttachments", () => {
  beforeEach(() => {
    resetAttachmentCounter();
    clearAttachmentRegistry();
    vi.clearAllMocks();
  });

  it("compacts every id in the list concurrently", async () => {
    const a = createImageAttachmentFromData("YWJj", "image/png", 1, 1);
    const b = createImageAttachmentFromData("ZGVm", "image/jpeg", 2, 2);
    const paste = createTextAttachment("not an image");

    spoolMock.mockImplementation(async (base64) => `/tmp/spooled-${base64}.png`);

    await compactImageAttachments([a.id, b.id, paste.id]);

    expect(spoolMock).toHaveBeenCalledTimes(2);
    expect((getAttachment(a.id)!.source as any).spoolPath).toBe("/tmp/spooled-YWJj.png");
    expect((getAttachment(b.id)!.source as any).spoolPath).toBe("/tmp/spooled-ZGVm.png");
    // Non-image attachment untouched.
    expect(getAttachment(paste.id)!.source).toEqual({ type: "text", text: "not an image" });
  });

  it("resolves even for an empty id list", async () => {
    await expect(compactImageAttachments([])).resolves.toBeUndefined();
    expect(spoolMock).not.toHaveBeenCalled();
  });
});
