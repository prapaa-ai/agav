import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { downscaleImage, MAX_RAW_IMAGE_BYTES } from "../utils/media-tools.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execFile so we don't touch the real clipboard.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("../utils/media-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/media-tools.js")>()),
  downscaleImage: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);
const mockDownscaleImage = vi.mocked(downscaleImage);

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAF/gL+wj5Z9QAAAABJRU5ErkJggg==",
  "base64",
);

/** Resolve execFile's callback with the given command's canned response, recording every call made. */
function mockClipboardTool(calls: string[], succeedsOn: string, response: Buffer): void {
  mockExecFile.mockImplementation(((command: string, _args: string[], _options: unknown, callback: Function) => {
    calls.push(command);
    if (command === succeedsOn) callback(null, response);
    else callback(new Error(`${command}: not found`));
  }) as typeof execFile);
}

describe("getClipboardImage on Linux", () => {
  const originalPlatform = process.platform;
  const originalCwd = process.cwd();
  const originalWaylandDisplay = process.env.WAYLAND_DISPLAY;
  let workingDirectory = "";

  beforeEach(async () => {
    vi.resetModules();
    mockExecFile.mockReset();
    mockDownscaleImage.mockReset();
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env.WAYLAND_DISPLAY;
    workingDirectory = await mkdtemp(join(tmpdir(), "agav-clipboard-image-"));
    process.chdir(workingDirectory);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (originalWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = originalWaylandDisplay;
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("reads PNG bytes via xclip on X11", async () => {
    const calls: string[] = [];
    mockClipboardTool(calls, "xclip", TINY_PNG);

    const { getClipboardImage } = await import("../utils/clipboard-image.js");
    const image = await getClipboardImage();

    expect(image?.mediaType).toBe("image/png");
    expect(Buffer.from(image?.base64 ?? "", "base64")).toEqual(TINY_PNG);
    expect(calls).toEqual(["xclip", "file"]);
    expect(mockExecFile).toHaveBeenCalledWith(
      "xclip",
      ["-selection", "clipboard", "-target", "image/png", "-out"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("prefers wl-paste over xclip when a Wayland session is active", async () => {
    process.env.WAYLAND_DISPLAY = "wayland-0";
    const calls: string[] = [];
    mockClipboardTool(calls, "wl-paste", TINY_PNG);

    const { getClipboardImage } = await import("../utils/clipboard-image.js");
    const image = await getClipboardImage();

    expect(image).not.toBeNull();
    expect(calls).toEqual(["wl-paste", "file"]);
    expect(mockExecFile).toHaveBeenCalledWith(
      "wl-paste",
      ["--type", "image/png"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("falls back to xclip when wl-paste is unavailable on a Wayland session", async () => {
    process.env.WAYLAND_DISPLAY = "wayland-0";
    const calls: string[] = [];
    mockClipboardTool(calls, "xclip", TINY_PNG);

    const { getClipboardImage } = await import("../utils/clipboard-image.js");
    const image = await getClipboardImage();

    expect(image).not.toBeNull();
    // Should have tried wl-paste first, then xclip.
    expect(calls).toEqual(["wl-paste", "xclip", "file"]);
  });

  it("returns null when neither clipboard tool has an image", async () => {
    mockExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(new Error("target not available"));
    }) as typeof execFile);

    const { getClipboardImage } = await import("../utils/clipboard-image.js");
    expect(await getClipboardImage()).toBeNull();
  });

  it("returns null when a clipboard tool exits cleanly with no data", async () => {
    mockExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, Buffer.alloc(0));
    }) as typeof execFile);

    const { getClipboardImage } = await import("../utils/clipboard-image.js");
    expect(await getClipboardImage()).toBeNull();
  });

  it("downscales a capture larger than the raw-image ceiling", async () => {
    const oversized = Buffer.alloc(MAX_RAW_IMAGE_BYTES + 1, 1);
    TINY_PNG.subarray(0, 8).copy(oversized, 0);
    const calls: string[] = [];
    mockClipboardTool(calls, "xclip", oversized);
    mockDownscaleImage.mockResolvedValue({
      data: TINY_PNG,
      mediaType: "image/jpeg",
      width: 800,
      height: 600,
    });

    const { getClipboardImage } = await import("../utils/clipboard-image.js");
    const image = await getClipboardImage();

    expect(mockDownscaleImage).toHaveBeenCalledTimes(1);
    expect(image?.mediaType).toBe("image/jpeg");
    expect(image?.width).toBe(800);
    expect(image?.height).toBe(600);
    expect(Buffer.from(image?.base64 ?? "", "base64")).toEqual(TINY_PNG);
  });

  it("sends the raw capture when downscaling is unavailable", async () => {
    const oversized = Buffer.alloc(MAX_RAW_IMAGE_BYTES + 1, 1);
    TINY_PNG.subarray(0, 8).copy(oversized, 0);
    const calls: string[] = [];
    mockClipboardTool(calls, "xclip", oversized);
    mockDownscaleImage.mockResolvedValue(null);

    const { getClipboardImage } = await import("../utils/clipboard-image.js");
    const image = await getClipboardImage();

    expect(image?.mediaType).toBe("image/png");
    expect(image?.base64).toBe(oversized.toString("base64"));
  });
});
