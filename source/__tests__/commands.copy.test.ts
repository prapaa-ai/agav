import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../ink/termio/clipboard.js", () => ({
  writeClipboard: vi.fn(),
}));

import { writeClipboard } from "../ink/termio/clipboard.js";
import { copyCommand } from "../commands/copy.js";
import type { CommandContext } from "../commands/types.js";
import type { Message } from "../providers/types.js";

const writeClipboardMock = vi.mocked(writeClipboard);

const createContext = (messages: Message[]): CommandContext => ({
  conversation: { getMessages: () => messages } as any,
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

describe("commands/copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports when there are no assistant messages", async () => {
    const context = createContext([{ role: "user", content: [{ type: "text", text: "hello" }] } as any]);
    const result = await copyCommand.execute("", context);

    expect(result.type).toBe("message");
    expect((result as any).text).toContain("no assistant messages found");
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it("copies the most recent assistant response text when no args are provided", async () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "first response" }] } as any,
      { role: "user", content: [{ type: "text", text: "hello" }] } as any,
      { role: "assistant", content: [{ type: "text", text: "second response" }] } as any,
    ];
    const context = createContext(messages);
    const result = await copyCommand.execute("", context);

    expect(result.type).toBe("message");
    expect((result as any).text).toBe("Copied last response to clipboard.");
    expect(writeClipboardMock).toHaveBeenCalledWith(process.stdout, "second response");
  });

  it("copies the Nth-most-recent assistant response when an argument is provided", async () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "first response" }] } as any,
      { role: "user", content: [{ type: "text", text: "hello" }] } as any,
      { role: "assistant", content: [{ type: "text", text: "second response" }] } as any,
    ];
    const context = createContext(messages);
    const result = await copyCommand.execute("2", context);

    expect(result.type).toBe("message");
    expect((result as any).text).toBe("Copied response -2 to clipboard.");
    expect(writeClipboardMock).toHaveBeenCalledWith(process.stdout, "first response");
  });

  it("reports an error for invalid N arguments", async () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "first response" }] } as any,
    ];
    const context = createContext(messages);
    
    // non-numeric string
    let result = await copyCommand.execute("abc", context);
    expect((result as any).text).toContain("Invalid message number");

    // negative number
    result = await copyCommand.execute("-1", context);
    expect((result as any).text).toContain("Invalid message number");

    // zero
    result = await copyCommand.execute("0", context);
    expect((result as any).text).toContain("Invalid message number");

    // decimal
    result = await copyCommand.execute("2.5", context);
    expect((result as any).text).toContain("Invalid message number");

    // partially-numeric string: parseInt would silently parse "2abc" as 2
    result = await copyCommand.execute("2abc", context);
    expect((result as any).text).toContain("Invalid message number");

    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it("reports an error if N is greater than available assistant messages", async () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "first response" }] } as any,
    ];
    const context = createContext(messages);
    const result = await copyCommand.execute("2", context);

    expect(result.type).toBe("message");
    expect((result as any).text).toContain("only 1 assistant message available");
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it("joins multiple text blocks correctly", async () => {
    const messages: Message[] = [
      { 
        role: "assistant", 
        content: [
          { type: "text", text: "block 1" },
          { type: "tool_use", id: "123", name: "test", input: {} },
          { type: "text", text: "block 2" }
        ] 
      } as any,
    ];
    const context = createContext(messages);
    const result = await copyCommand.execute("", context);

    expect(result.type).toBe("message");
    expect(writeClipboardMock).toHaveBeenCalledWith(process.stdout, "block 1\nblock 2");
  });

  it("tool-only assistant messages do not consume an N slot", async () => {
    // History: [text answer 1] [tool-only turn] [text answer 2]
    // /copy 2 must skip the tool-only turn and reach "first response".
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "first response" }] } as any,
      {
        role: "assistant",
        content: [{ type: "tool_use", toolCallId: "t1", toolName: "shell", toolInput: {} }],
      } as any,
      { role: "assistant", content: [{ type: "text", text: "second response" }] } as any,
    ];
    const context = createContext(messages);

    const latestResult = await copyCommand.execute("", context);
    expect(writeClipboardMock).toHaveBeenCalledWith(process.stdout, "second response");

    vi.clearAllMocks();

    const prevResult = await copyCommand.execute("2", context);
    expect(writeClipboardMock).toHaveBeenCalledWith(process.stdout, "first response");
    expect((prevResult as any).text).toBe("Copied response -2 to clipboard.");

    // Only 2 text-bearing messages exist; N=3 should report that.
    const overResult = await copyCommand.execute("3", context);
    expect((overResult as any).text).toContain("only 2 assistant messages available");
    expect(writeClipboardMock).toHaveBeenCalledTimes(1);
  });
});
