import { describe, it, expect, beforeEach, vi } from "vitest";

import { compactCommand } from "../commands/compact.js";
import type { CommandContext } from "../commands/types.js";

type CompactResult = { compacted: boolean; droppedCount: number };

/**
 * A conversation stub whose token count drops to `after` once compaction runs,
 * the way a real compaction shrinks the history.
 */
const createConversation = (before: number, after: number, result: CompactResult) => {
  let tokenCount = before;
  return {
    get tokenCount() {
      return tokenCount;
    },
    compactIfNeeded: vi.fn(async () => {
      if (result.compacted) tokenCount = after;
      return result;
    }),
  };
};

// No provider: /compact passes no summarizer, so nothing reaches the network.
const createContext = (conversation: ReturnType<typeof createConversation>): CommandContext => ({
  conversation: conversation as any,
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

describe("commands/compact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces compaction without a summarizer and shows progress first", async () => {
    const conversation = createConversation(1200, 1200, { compacted: false, droppedCount: 0 });
    const context = createContext(conversation);

    await compactCommand.execute("", context);

    expect(context.showStatus).toHaveBeenCalledWith("Compacting conversation...");
    expect(conversation.compactIfNeeded).toHaveBeenCalledTimes(1);
    expect(conversation.compactIfNeeded).toHaveBeenCalledWith(true, undefined);
    expect(vi.mocked(context.showStatus).mock.invocationCallOrder[0]).toBeLessThan(
      conversation.compactIfNeeded.mock.invocationCallOrder[0],
    );
    expect(context.addTokenUsage).not.toHaveBeenCalled();
  });

  it("neither saves nor refreshes when the conversation is already compact", async () => {
    const context = createContext(createConversation(1200, 1200, { compacted: false, droppedCount: 0 }));

    const result = await compactCommand.execute("", context);

    expect(result).toEqual({ type: "message", text: "Conversation is already compact (~1200 tokens)." });
    expect(context.saveSession).not.toHaveBeenCalled();
    expect(context.refreshDisplay).not.toHaveBeenCalled();
  });

  it("saves and refreshes once after compacting and reports the dropped messages and token counts", async () => {
    const context = createContext(createConversation(5000, 1800, { compacted: true, droppedCount: 12 }));

    const result = await compactCommand.execute("", context);

    expect(context.saveSession).toHaveBeenCalledTimes(1);
    expect(context.refreshDisplay).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("message");
    expect((result as any).text).toContain("Compacted: 12 messages summarized, ~5000 → ~1800 tokens");
  });
});
