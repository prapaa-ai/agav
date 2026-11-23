import { beforeEach, describe, expect, it, vi } from "vitest";
import { historyCommand } from "../commands/history.js";
import type { CommandContext } from "../commands/types.js";
import { openResourceManager } from "../commands/resource-manager.js";
import { listSessions, type SessionRecord } from "../config/history.js";

vi.mock("../config/history.js", () => ({ listSessions: vi.fn() }));
vi.mock("../commands/resource-manager.js", () => ({ openResourceManager: vi.fn() }));
const read = vi.mocked(listSessions);
const open = vi.mocked(openResourceManager);
const context = {} as CommandContext;
const records = ["newest", "middle", "oldest"].map((title, idx): SessionRecord => ({
  id: `0000000${idx}-session`, title, createdAt: "2026-11-17T00:00:00Z", model: "test", messages: [], provider: "ollama",
}));

beforeEach(() => {
  vi.resetAllMocks();
  read.mockResolvedValue(records);
});

describe("/history list --limit", () => {
  it("limits ordered output and reports the count when it omits records", async () => {
    const result = await historyCommand.execute("list --limit 2", context);
    expect(result).toEqual({
      type: "message",
      text: [
        "00000000 · newest · 0 messages",
        "00000001 · middle · 0 messages",
        "Showing 2 of 3 saved sessions.",
      ].join("\n"),
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps titles on one line and handles long or missing titles in text output", async () => {
    const { title: _omittedTitle, ...untitled } = records[2]!;
    const legacyUntitled = untitled as SessionRecord;
    read.mockResolvedValue([
      { ...records[0]!, title: "Two\nlines" },
      { ...records[1]!, title: "x".repeat(300) },
      legacyUntitled,
    ]);
    expect(await historyCommand.execute("list", context)).toEqual({
      type: "message",
      text: [
        "00000000 · Two lines · 0 messages",
        `00000001 · ${"x".repeat(79)}… · 0 messages`,
        "00000002 · Untitled session · 0 messages",
      ].join("\n"),
    });
  });

  it("leaves equal and oversized requests, unbounded listing and empty history unchanged", async () => {
    const all = await historyCommand.execute("list", context);
    expect(await historyCommand.execute("list --limit 3", context)).toEqual(all);
    expect(await historyCommand.execute("list --limit 8", context)).toEqual(all);
    read.mockResolvedValue([]);
    expect(await historyCommand.execute("list --limit 2", context)).toEqual({
      type: "message", text: "No saved sessions.",
    });
  });

  it.each(["", "0", "-1", "1.5", "2e2", "x", "9007199254740992", "1 2"])("rejects a malformed limit '%s' before reading", async (value) => {
    const result = await historyCommand.execute("list --limit " + value, context);
    expect(result).toMatchObject({ type: "message", text: expect.stringContaining("positive safe integer") });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps bare history interactive where available", async () => {
    const interactive = { type: "message", text: "interactive" } as const;
    open.mockResolvedValue(interactive);
    expect(await historyCommand.execute("", context)).toEqual(interactive);
    expect(open).toHaveBeenCalledWith("history", context);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("/history list filters", () => {
  it("combines literal model and exact provider filters before applying the limit", async () => {
    read.mockResolvedValue([
      { ...records[0]!, provider: "openai", model: "other" },
      { ...records[1]!, model: "Model.v2" },
      { ...records[2]!, model: "MODEL.V2" },
    ]);
    expect(await historyCommand.execute("list --model model.v2 --limit 1 --provider ollama", context)).toEqual({
      type: "message", text: "00000001 · middle · 0 messages\nShowing 1 of 2 saved sessions.",
    });
    expect(await historyCommand.execute("list --provider Ollama", context)).toEqual({
      type: "message", text: "No saved sessions match the filters.",
    });
  });

  it.each(["list --model", "list --provider --model x", "list --model x --model y"])("rejects %s before reading", async (args) => {
    expect((await historyCommand.execute(args, context)).type).toBe("message");
    expect(read).not.toHaveBeenCalled();
  });
});
