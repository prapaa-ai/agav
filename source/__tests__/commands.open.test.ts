import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../utils/open-target.js", () => ({
  openTarget: vi.fn(),
}));

vi.mock("../utils/open-external.js", () => ({
  spoolImageToTempFile: vi.fn(),
  cleanupSpooledImages: vi.fn().mockResolvedValue(undefined),
}));

import { openTarget } from "../utils/open-target.js";
import { spoolImageToTempFile } from "../utils/open-external.js";
import { openCommand } from "../commands/open.js";
import type { CommandContext } from "../commands/types.js";
import {
  resetAttachmentCounter,
  createTextAttachment,
  createImageAttachmentFromData,
  createFileAttachment,
} from "../utils/attachments.js";
import { clearAttachmentRegistry, getAttachment } from "../utils/attachment-registry.js";

const openTargetMock = vi.mocked(openTarget);
const spoolImageMock = vi.mocked(spoolImageToTempFile);

const createContext = (): CommandContext => ({
  conversation: {} as any,
  config: {} as any,
  setModel: vi.fn(),
  setProvider: vi.fn(),
  setEffort: vi.fn(),
  clearMessages: vi.fn(),
  refreshPlan: vi.fn(),
  showStatus: vi.fn(),
  saveSession: vi.fn(),
  refreshDisplay: vi.fn(),
  loadSession: vi.fn(),
  activateSession: vi.fn(),
  renameSession: vi.fn(),
  exit: vi.fn(),
  getDebugState: vi.fn(),
  submit: vi.fn(),
  handleSubmit: vi.fn(),
  toolRegistry: {} as any,
  addTokenUsage: vi.fn(),
  setRunningSkill: vi.fn(),
  setPickerActive: vi.fn(),
  suspendTerminal: vi.fn(() => vi.fn()),
  showAgentsTUI: vi.fn(),
  showSkillsTUI: vi.fn(),
});

describe("commands/open", () => {
  beforeEach(() => {
    resetAttachmentCounter();
    clearAttachmentRegistry();
    vi.clearAllMocks();
  });

  it("reports no attachments yet when the registry is empty and args are blank", async () => {
    const context = createContext();
    const result = await openCommand.execute("", context);

    expect(result.type).toBe("message");
    expect((result as any).text.toLowerCase()).toContain("no attachments");
  });

  it("lists every registered attachment by #id [kind] summary, and mentions /open <n>", async () => {
    const paste = createTextAttachment("hello world");
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);
    const file = createFileAttachment("/abs/src/app.ts", "src/app.ts");

    const context = createContext();
    const result = await openCommand.execute("", context);
    const text = (result as any).text as string;

    expect(text).toContain(`#${paste.id} [paste] ${paste.summary}`);
    expect(text).toContain(`#${image.id} [image] ${image.summary}`);
    expect(text).toContain(`#${file.id} [file] ${file.summary}`);
    expect(text).toContain("/open <n>");
  });

  it("reports a non-numeric argument as invalid", async () => {
    const context = createContext();
    const result = await openCommand.execute("abc", context);

    expect((result as any).text).toContain(`"abc"`);
    expect((result as any).text.toLowerCase()).toContain("not a valid attachment number");
  });

  it("reports a nonexistent attachment id as not found", async () => {
    const context = createContext();
    const result = await openCommand.execute("9999", context);

    expect((result as any).text).toContain("#9999");
    expect((result as any).text.toLowerCase()).toMatch(/not found|no longer available/);
  });

  it("shows a paste attachment's summary and full text when short", async () => {
    const paste = createTextAttachment("hello world");
    const context = createContext();

    const result = await openCommand.execute(String(paste.id), context);
    const text = (result as any).text as string;

    expect(text).toContain(paste.summary);
    expect(text).toContain("hello world");
  });

  it("truncates a long paste attachment's text with a note", async () => {
    const longText = "x".repeat(600);
    const paste = createTextAttachment(longText);
    const context = createContext();

    const result = await openCommand.execute(String(paste.id), context);
    const text = (result as any).text as string;

    expect(text).toContain("x".repeat(500));
    expect(text).not.toContain("x".repeat(501));
    expect(text.toLowerCase()).toContain("truncated");
    expect(text).toContain("600 chars total");
  });

  it("forwards openTarget's outcome message for a file attachment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-open-cmd-"));
    try {
      const absPath = join(dir, "app.ts");
      await writeFile(absPath, "export {};\n");
      const file = createFileAttachment(absPath, "app.ts");

      openTargetMock.mockResolvedValue({ ok: true, message: "Opened app.ts in VS Code." });

      const context = createContext();
      const result = await openCommand.execute(String(file.id), context);

      expect(openTargetMock).toHaveBeenCalledWith({ kind: "file", absPath });
      expect((result as any).text).toBe("Opened app.ts in VS Code.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forwards openTarget's outcome for an image attachment that already has a spoolPath", async () => {
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);
    const registered = getAttachment(image.id)!;
    (registered.source as any).spoolPath = "/tmp/agav-images/image-fake.png";

    openTargetMock.mockResolvedValue({ ok: true, message: "Opened /tmp/agav-images/image-fake.png." });

    const context = createContext();
    const result = await openCommand.execute(String(image.id), context);

    expect(spoolImageMock).not.toHaveBeenCalled();
    expect(openTargetMock).toHaveBeenCalledWith({ kind: "file", absPath: "/tmp/agav-images/image-fake.png" });
    expect((result as any).text).toBe("Opened /tmp/agav-images/image-fake.png.");
  });

  it("spools an image attachment with only base64 data, then forwards openTarget's outcome", async () => {
    const image = createImageAttachmentFromData("YWJj", "image/png", 800, 600);

    spoolImageMock.mockResolvedValue("/tmp/agav-images/image-spooled.png");
    openTargetMock.mockResolvedValue({ ok: true, message: "Opened /tmp/agav-images/image-spooled.png." });

    const context = createContext();
    const result = await openCommand.execute(String(image.id), context);

    expect(spoolImageMock).toHaveBeenCalledWith("YWJj", "image/png");
    expect(openTargetMock).toHaveBeenCalledWith({ kind: "file", absPath: "/tmp/agav-images/image-spooled.png" });
    expect((result as any).text).toBe("Opened /tmp/agav-images/image-spooled.png.");
  });
});
