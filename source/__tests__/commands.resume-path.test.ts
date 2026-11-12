import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { resumeCommand } from "../commands/history.js";
import type { CommandContext } from "../commands/types.js";
import { listResumableSessions, loadResumableSession } from "../sessions/history.js";
import { pickSession } from "../utils/session-picker.js";
import { terminalRelativePaths } from "../utils/display-path.js";
vi.mock("../sessions/history.js", () => ({ listResumableSessions: vi.fn(), loadResumableSession: vi.fn() }));
vi.mock("../utils/session-picker.js", () => ({ pickSession: vi.fn(), START_NEW_SESSION: "new" }));
describe("resume working directory", () => {
  it.each(["", "demo"])("preserves the absolute path when resuming with %j", async args => {
    for (const cwd of [process.cwd(), join(process.cwd(), "child")]) {
      const session = { id: "demo", title: "Demo", createdAt: new Date().toISOString(), messages: [], model: "mock", provider: "openai",
        runtime: { generation: "g", status: "completed" as const, pendingCount: 0, cwd } };
      vi.mocked(listResumableSessions).mockResolvedValue([session]);
      vi.mocked(loadResumableSession).mockResolvedValue(session);
      vi.mocked(pickSession).mockResolvedValue(session);
      const context = { loadSession: vi.fn(), setModel: vi.fn(), setProvider: vi.fn(), setPickerActive: vi.fn(),
        suspendTerminal: () => vi.fn(), refreshDisplay: vi.fn() } as unknown as CommandContext;
      const result = await resumeCommand.execute(args, context);
      expect(result.type).toBe("message");
      if (result.type !== "message") return;
      expect(result.preservePaths).toBe(true);
      expect(result.preservePaths ? result.text : terminalRelativePaths(result.text)).toContain(`Working directory: ${cwd}`);
    }
  });
});

describe("/resume start-new-session outcome", () => {
  it("starts a new chat like /new instead of loading a session", async () => {
    const session = { id: "demo", title: "Demo", createdAt: new Date().toISOString(), messages: [], model: "mock", provider: "openai" };
    vi.mocked(listResumableSessions).mockResolvedValue([session]);
    vi.mocked(loadResumableSession).mockClear();
    vi.mocked(pickSession).mockResolvedValue("new");
    const context = { clearMessages: vi.fn(), loadSession: vi.fn(), setModel: vi.fn(), setProvider: vi.fn(), setPickerActive: vi.fn(),
      suspendTerminal: () => vi.fn(), refreshDisplay: vi.fn() } as unknown as CommandContext;
    const result = await resumeCommand.execute("", context);
    expect(context.clearMessages).toHaveBeenCalledOnce();
    expect(context.loadSession).not.toHaveBeenCalled();
    expect(loadResumableSession).not.toHaveBeenCalled();
    expect(context.setPickerActive).toHaveBeenLastCalledWith(false);
    expect(result).toMatchObject({ type: "message", text: expect.stringContaining("Started a new chat") });
  });
});
