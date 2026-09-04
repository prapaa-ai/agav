import { describe, it, expect } from "vitest";
import { extensionForImage } from "../utils/open-external.js";

describe("extensionForImage", () => {
  it("maps media types to file extensions", () => {
    expect(extensionForImage("image/png")).toBe(".png");
    expect(extensionForImage("image/jpeg")).toBe(".jpg");
    expect(extensionForImage("image/gif")).toBe(".gif");
    expect(extensionForImage("image/webp")).toBe(".webp");
    expect(extensionForImage("image/bmp")).toBe(".bmp");
  });

  it("falls back to .png for unknown types", () => {
    expect(extensionForImage(undefined)).toBe(".png");
    expect(extensionForImage("image/svg+xml")).toBe(".png");
  });
});
