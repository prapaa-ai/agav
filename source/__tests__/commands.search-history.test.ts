import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../config/history.js", () => ({
  listSessions: vi.fn(),
}));

import { listSessions } from "../config/history.js";
import { searchCommand, searchHistoryCommand } from "../commands/search-history.js";
import type { CommandContext } from "../commands/types.js";
import type { SessionRecord } from "../config/history.js";

const listSessionsMock = vi.mocked(listSessions);

const context = {} as CommandContext;

const session = (overrides: Partial<SessionRecord>): SessionRecord => ({
  id: "01234567-89ab-cdef-0123-456789abcdef",
  createdAt: "2026-01-01T00:00:00.000Z",
  model: "test-model",
  provider: "test-provider",
  title: "Untitled session",
  messages: [],
  ...overrides,
});

const textMessage = (text: string) =>
  ({ role: "user", content: [{ type: "text", text }] }) as SessionRecord["messages"][number];

const run = (query: string) => searchCommand.execute(query, context);

describe("commands/search-history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessionsMock.mockResolvedValue([]);
  });

  it("matches a session by its saved name even when no message text matches", async () => {
    listSessionsMock.mockResolvedValue([
      session({
        id: "aaaaaaaa-1111-2222-3333-444444444444",
        name: "OAuth provider bug",
        title: "generic title",
        messages: [textMessage("nothing relevant here")],
      }),
    ]);

    const result = await run("oauth");

    expect(result.type).toBe("message");
    const text = (result as { text: string }).text;
    expect(text).toContain('matched name "OAuth provider bug"');
    expect(text).toContain("1 session matches");
    // No message matched, so no excerpt may be fabricated.
    expect(text).not.toContain("nothing relevant here");
    // No message matches: the result must not claim any.
    expect(text).not.toMatch(/\d+ match(es)?( ·|$)/);
  });

  it("matches a session by its title when it has no saved name", async () => {
    listSessionsMock.mockResolvedValue([
      session({
        id: "bbbbbbbb-1111-2222-3333-444444444444",
        title: "Refactor tokenizer pipeline",
        messages: [textMessage("unrelated message body")],
      }),
    ]);

    const result = await run("tokenizer");

    const text = (result as { text: string }).text;
    expect(text).toContain('matched title "Refactor tokenizer pipeline"');
    expect(text).not.toContain("unrelated message body");
  });

  it("returns a session once when name/title and messages all match", async () => {
    listSessionsMock.mockResolvedValue([
      session({
        id: "cccccccc-1111-2222-3333-444444444444",
        name: "deploy the gateway",
        title: "deploy the gateway",
        messages: [textMessage("we deploy the gateway on friday")],
      }),
    ]);

    const result = await run("deploy");

    const text = (result as { text: string }).text;
    expect(text).toContain("1 session matches");
    expect(text.match(/1\. deploy the gateway/g)).toHaveLength(1);
    // Both the message match count and the metadata match are shown.
    expect(text).toContain("1 match");
    expect(text).toContain('matched name/title "deploy the gateway"');
    // The message excerpt is still present.
    expect(text).toContain("we deploy the gateway on friday");
  });

  it("still matches sessions that have neither a name nor a title hit", async () => {
    listSessionsMock.mockResolvedValue([
      session({
        id: "dddddddd-1111-2222-3333-444444444444",
        messages: [textMessage("the cache eviction bug is back")],
      }),
    ]);

    const result = await run("eviction");

    const text = (result as { text: string }).text;
    expect(text).toContain("1 session matches");
    expect(text).toContain("1 match");
    expect(text).not.toContain("matched ");
    expect(text).toContain("the cache eviction bug is back");
  });

  it("reports no sessions when nothing matches", async () => {
    listSessionsMock.mockResolvedValue([
      session({
        name: "alpha",
        title: "beta",
        messages: [textMessage("gamma delta")],
      }),
    ]);

    const result = await run("omega");

    expect(result).toEqual({ type: "message", text: 'No sessions matching "omega".' });
  });

  it("matches name, title, and message text case-insensitively", async () => {
    listSessionsMock.mockResolvedValue([
      session({
        id: "eeeeeeee-1111-2222-3333-444444444444",
        name: "Release Checklist",
        title: "untouched",
        messages: [textMessage("nothing")],
      }),
      session({
        id: "ffffffff-1111-2222-3333-444444444444",
        name: undefined,
        title: "LINUX Build Notes",
        messages: [textMessage("nothing")],
      }),
      session({
        id: "99999999-1111-2222-3333-444444444444",
        title: "untouched",
        messages: [textMessage("The PIPELINE failed")],
      }),
    ]);

    const result = await run("release");

    const text = (result as { text: string }).text;
    expect(text).toContain('matched name "Release Checklist"');
    expect(text).toContain("1 session matches");

    const titleResult = await run("linux");
    expect((titleResult as { text: string }).text).toContain('matched title "LINUX Build Notes"');

    const messageResult = await run("pipeline");
    expect((messageResult as { text: string }).text).toContain("The PIPELINE failed");
  });

  it("keeps the ten-session limit, counting metadata matches toward it", async () => {
    const many: SessionRecord[] = [];
    for (let i = 0; i < 12; i++) {
      many.push(
        session({
          id: `${String(i).padStart(8, "0")}-1111-2222-3333-444444444444`,
          name: `needle session ${i}`,
          title: `untouched ${i}`,
          messages: [textMessage("no match in messages")],
        }),
      );
    }
    listSessionsMock.mockResolvedValue(many);

    const result = await run("needle");

    const text = (result as { text: string }).text;
    expect(text).toContain("10 sessions match");
    expect(text.match(/needle session/g)).toHaveLength(10);
    expect(text).not.toContain("needle session 10");
    expect(text).not.toContain("needle session 11");
  });

  it("preserves the interactive no-argument flow and empty-query usage message", async () => {
    // Headless context: no showResourceTUI, so the bare command falls through
    // to the usage message instead of opening the picker.
    const result = await searchCommand.execute("", context);
    expect(result).toEqual({ type: "message", text: "Usage: /search <keyword>" });
    expect(listSessionsMock).not.toHaveBeenCalled();
  });

  it("keeps /search-history as an exact alias of /search", async () => {
    expect(searchHistoryCommand.name).toBe("search-history");
    expect(searchHistoryCommand.description).toBe(searchCommand.description);

    listSessionsMock.mockResolvedValue([
      session({
        name: "alias probe",
        title: "untouched",
        messages: [textMessage("nothing")],
      }),
    ]);

    const text = (await searchHistoryCommand.execute("alias probe", context)) as { text: string };
    expect(text.text).toContain('matched name "alias probe"');
  });
});
