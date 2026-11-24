import { beforeEach, describe, expect, it, vi } from "vitest";
import { branchCommand } from "../commands/branch.js";
import type { CommandContext } from "../commands/types.js";
import { listSessions, saveSession, type SessionRecord } from "../config/history.js";
import { listResumableSessions, loadResumableSession } from "../sessions/history.js";
import type { Message } from "../providers/types.js";

vi.mock("../config/history.js", () => ({ listSessions: vi.fn(), saveSession: vi.fn() }));
vi.mock("../sessions/history.js", () => ({ listResumableSessions: vi.fn(), loadResumableSession: vi.fn() }));

const read = vi.mocked(listResumableSessions);
const load = vi.mocked(loadResumableSession);

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

const record = (id: string, title: string, parentId?: string): SessionRecord => ({
  id,
  title,
  createdAt: "2026-11-21T00:00:00Z",
  model: "claude-sonnet-4-20250514",
  provider: "anthropic",
  messages,
  ...(parentId ? { parentId } : {}),
});

const ROOT = record("aaaa1111-root", "Root chat");
const BRANCH_A = record("aaaa2222-branch-a", "Branch A", ROOT.id);
const BRANCH_B = record("aaaa3333-branch-b", "Branch B", ROOT.id);
const OTHER = record("bbbb4444-other", "Other chat");
const SESSIONS = [ROOT, BRANCH_A, BRANCH_B, OTHER];

const context = (currentSessionId: string | undefined = BRANCH_A.id): CommandContext => ({
  currentSessionId,
  config: { model: "default-model" },
  loadSession: vi.fn(),
  setModel: vi.fn(),
  setProvider: vi.fn(),
  activateSession: vi.fn(),
  getDebugState: vi.fn(() => ({})),
  conversation: { getMessages: () => messages, wasCompacted: false },
} as unknown as CommandContext);

const run = async (args: string, currentSessionId = BRANCH_A.id) => {
  const result = await branchCommand.execute(args, context(currentSessionId));
  if (result.type !== "message") throw new Error(`expected a message, got ${result.type}`);
  return result;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listSessions).mockResolvedValue(SESSIONS);
  read.mockResolvedValue(SESSIONS);
  load.mockImplementation(async (id: string) => SESSIONS.find((s) => s.id === id) ?? null);
});

describe("/branch checkout", () => {
  it("checks out a branch by unique prefix, loading it like /resume", async () => {
    const ctx = context();
    const result = await branchCommand.execute("checkout aaaa2222", ctx);

    expect(result).toEqual({
      type: "message",
      preservePaths: true,
      text: "Checked out branch aaaa2222: Branch A (1 messages)",
    });
    expect(load).toHaveBeenCalledWith(BRANCH_A.id);
    expect(ctx.loadSession).toHaveBeenCalledWith(BRANCH_A);
    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet-4-20250514");
    expect(ctx.setProvider).toHaveBeenCalledWith("anthropic");
  });

  it("checks out by full ID even when the prefix is shared", async () => {
    const result = await run(`checkout ${BRANCH_B.id}`);

    expect(result.text).toBe("Checked out branch aaaa3333: Branch B (1 messages)");
    expect(load).toHaveBeenCalledWith(BRANCH_B.id);
  });

  it("rejects an ambiguous prefix with a bounded list and changes nothing", async () => {
    const ctx = context();
    const result = await branchCommand.execute("checkout aaaa", ctx);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected a message");
    expect(result.text).toContain(`Ambiguous branch prefix "aaaa".`);
    expect(result.text).toContain("aaaa1111 · Root chat");
    expect(result.text).toContain("aaaa2222 · Branch A");
    expect(result.text).toContain("aaaa3333 · Branch B");
    expect(result.text).not.toContain("bbbb4444");
    expect(load).not.toHaveBeenCalled();
    expect(ctx.loadSession).not.toHaveBeenCalled();
  });

  it("bounds a long ambiguous list at 10 and names the remainder", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      record(`dddd${String(i).padStart(4, "0")}-branch`, `Branch ${i}`, ROOT.id));
    read.mockResolvedValue([ROOT, BRANCH_A, ...many, OTHER]);

    const result = await run("checkout dddd");

    expect(result.text).toContain("… and 2 more matches.");
    expect(result.text).not.toContain("Branch 10");
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects a branch from another chat with /resume guidance", async () => {
    const ctx = context();
    const result = await branchCommand.execute("checkout bbbb", ctx);

    expect(result).toEqual({
      type: "message",
      text: `Branch "bbbb" belongs to another chat, not the current one. Use /resume bbbb4444 to switch to it.`,
    });
    expect(load).not.toHaveBeenCalled();
    expect(ctx.loadSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown ID with guidance to list branches", async () => {
    const ctx = context();
    const result = await branchCommand.execute("checkout zzzz", ctx);

    expect(result).toEqual({
      type: "message",
      text: `No branch matching "zzzz" in the current chat. Use /branch to list branches.`,
    });
    expect(load).not.toHaveBeenCalled();
    expect(ctx.loadSession).not.toHaveBeenCalled();
  });

  it("requires an active session to scope the checkout", async () => {
    const ctx = { ...context(), currentSessionId: undefined };
    const result = await branchCommand.execute("checkout aaaa2222", ctx as CommandContext);

    expect(result).toEqual({
      type: "message",
      text: "No active session to check out a branch from. Use /resume <id> to load a session first.",
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("reports a failed load without changing the conversation", async () => {
    load.mockResolvedValue(null);
    const ctx = context();
    const result = await branchCommand.execute("checkout aaaa2222", ctx);

    expect(result).toEqual({ type: "message", text: "Failed to load session." });
    expect(ctx.loadSession).not.toHaveBeenCalled();
  });

  it("shows usage for extra words after the prefix", async () => {
    const ctx = context();
    const result = await branchCommand.execute("checkout aaaa2222 extra", ctx);

    expect(result).toEqual({ type: "message", text: "Usage: /branch checkout <id-or-prefix>" });
    expect(load).not.toHaveBeenCalled();
  });

  it("still forks a branch literally named checkout when no ID follows", async () => {
    vi.mocked(saveSession).mockResolvedValue("newbranchid");
    const ctx = context();
    const result = await branchCommand.execute("checkout", ctx);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected a message");
    expect(result.text).toContain(`Branched conversation as "checkout" (newbranc)`);
    expect(ctx.activateSession).toHaveBeenCalledWith("newbranchid", "checkout");
  });
});
