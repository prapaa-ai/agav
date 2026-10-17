import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSessionsCommand } from "../cli/sessions-cli.js";
import * as history from "../config/history.js";

vi.mock("../config/history.js", () => ({
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
}));

describe("sessions-cli", () => {
  let consoleLogMock: any;
  let consoleErrorMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fails if no command is provided", async () => {
    const exitCode = await runSessionsCommand(undefined, []);
    expect(exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Usage: agav sessions"));
  });

  it("fails on unknown command", async () => {
    const exitCode = await runSessionsCommand("foobar", []);
    expect(exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Unknown sessions command 'foobar'"));
  });

  it("fails if unknown flag is passed", async () => {
    const exitCode = await runSessionsCommand("delete", ["123", "--bogus"]);
    expect(exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Unknown option '--bogus'"));
  });

  it("fails if delete is called without session ID", async () => {
    const exitCode = await runSessionsCommand("delete", []);
    expect(exitCode).toBe(1);
    expect(history.deleteSession).not.toHaveBeenCalled();
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("No session ID provided"));
  });

  it("rejects empty or whitespace-only session ID for delete and does not call deleteSession", async () => {
    vi.mocked(history.listSessions).mockResolvedValue([
      { id: "session-abc-123", title: "Test", createdAt: "", model: "", provider: "", messages: [] },
    ]);

    for (const emptyId of ["", "   ", "\t", "\n"]) {
      const exitCode = await runSessionsCommand("delete", [emptyId]);
      expect(exitCode).toBe(1);
      expect(history.deleteSession).not.toHaveBeenCalled();
      expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("No session ID provided"));
    }
  });

  it("rejects empty or whitespace-only session ID for rm and does not call deleteSession", async () => {
    vi.mocked(history.listSessions).mockResolvedValue([
      { id: "session-abc-123", title: "Test", createdAt: "", model: "", provider: "", messages: [] },
    ]);

    for (const emptyId of ["", "   ", "\t", "\n"]) {
      const exitCode = await runSessionsCommand("rm", [emptyId]);
      expect(exitCode).toBe(1);
      expect(history.deleteSession).not.toHaveBeenCalled();
      expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("No session ID provided"));
    }
  });

  it("fails if extra arguments are provided to delete", async () => {
    const exitCode = await runSessionsCommand("delete", ["id-1", "id-2"]);
    expect(exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Unexpected argument 'id-2'"));
  });

  it("fails when session is not found", async () => {
    vi.mocked(history.listSessions).mockResolvedValue([
      { id: "session-abc-123", title: "Test", createdAt: "", model: "", provider: "", messages: [] },
    ]);

    const exitCode = await runSessionsCommand("delete", ["nonexistent-id"]);
    expect(exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Session 'nonexistent-id' not found"));
  });

  it("fails when prefix is ambiguous", async () => {
    vi.mocked(history.listSessions).mockResolvedValue([
      { id: "session-abc-1", title: "Test 1", createdAt: "", model: "", provider: "", messages: [] },
      { id: "session-abc-2", title: "Test 2", createdAt: "", model: "", provider: "", messages: [] },
    ]);

    const exitCode = await runSessionsCommand("delete", ["session-abc"]);
    expect(exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Ambiguous session ID prefix 'session-abc'"));
  });

  it("successfully deletes by exact ID", async () => {
    vi.mocked(history.listSessions).mockResolvedValue([
      { id: "session-abc-123", title: "Test", createdAt: "", model: "", provider: "", messages: [] },
    ]);
    vi.mocked(history.deleteSession).mockResolvedValue(true);

    const exitCode = await runSessionsCommand("delete", ["session-abc-123"]);
    expect(exitCode).toBe(0);
    expect(history.deleteSession).toHaveBeenCalledWith("session-abc-123");
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining("✓ Deleted session session-abc-123"));
  });

  it("successfully deletes by unique prefix using rm alias", async () => {
    vi.mocked(history.listSessions).mockResolvedValue([
      { id: "abcdef-12345", title: "Test", createdAt: "", model: "", provider: "", messages: [] },
      { id: "zxyvwu-67890", title: "Test 2", createdAt: "", model: "", provider: "", messages: [] },
    ]);
    vi.mocked(history.deleteSession).mockResolvedValue(true);

    const exitCode = await runSessionsCommand("rm", ["abc"]);
    expect(exitCode).toBe(0);
    expect(history.deleteSession).toHaveBeenCalledWith("abcdef-12345");
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining("✓ Deleted session abcdef-12345"));
  });

  it("handles deletion failure", async () => {
    vi.mocked(history.listSessions).mockResolvedValue([
      { id: "session-abc-123", title: "Test", createdAt: "", model: "", provider: "", messages: [] },
    ]);
    vi.mocked(history.deleteSession).mockResolvedValue(false);

    const exitCode = await runSessionsCommand("delete", ["session-abc-123"]);
    expect(exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining("Failed to delete session 'session-abc-123'"));
  });
});
