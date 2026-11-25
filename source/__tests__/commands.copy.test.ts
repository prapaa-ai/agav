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

  it("copies complete backtick and tilde blocks in order from the latest response", async () => {
    const earlier = { role: "assistant", content: [{ type: "text", text: "```\nolder\n```" }] } as Message;
    const latest = {
      role: "assistant",
      content: [{
        type: "text",
        text: ["Prose `inline`", "", "    indented code", "", "```ts", "  first()", "  next()", "```",
          "", "~~~sh", "echo second", "~~~", "", "```", "unclosed"].join("\n"),
      }],
    } as Message;
    const context = createContext([earlier, latest]);

    await copyCommand.execute("code", context);
    await copyCommand.execute("code 2", context);
    expect(writeClipboardMock.mock.calls.map((call) => call[1])).toEqual(["  first()\n  next()", "echo second"]);

    writeClipboardMock.mockClear();
    expect(await copyCommand.execute("code 3", context)).toEqual({
      type: "message", text: "Nothing to copy (only 2 fenced code blocks available).",
    });
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it("does not search older responses when the latest has no complete fence", async () => {
    const context = createContext([
      { role: "assistant", content: [{ type: "text", text: "~~~\nolder\n~~~" }] },
      { role: "assistant", content: [{ type: "text", text: "~~~\nunclosed" }] },
    ] as Message[]);
    expect(await copyCommand.execute("code", context)).toEqual({
      type: "message", text: "Nothing to copy (no complete fenced code blocks in the latest response).",
    });
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it("copies a block from an older response with --response, numbered as /copy N", async () => {
    const context = createContext([
      { role: "assistant", content: [{ type: "text", text: "```\nthird a\n```\n\n~~~\nthird b\n~~~" }] },
      { role: "assistant", content: [{ type: "text", text: "no fence here" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "```\nlatest\n```" }] },
    ] as Message[]);

    expect(await copyCommand.execute("code 2 --response 3", context)).toEqual({
      type: "message", text: "Copied code block 2 from response -3 to clipboard.",
    });
    expect(await copyCommand.execute("code --response 3", context)).toEqual({
      type: "message", text: "Copied code block 1 from response -3 to clipboard.",
    });
    expect(await copyCommand.execute("code --response 1", context)).toEqual({
      type: "message", text: "Copied code block 1 to clipboard.",
    });
    expect(writeClipboardMock.mock.calls.map((call) => call[1])).toEqual(["third b", "third a", "latest"]);
  });

  it("says which index failed with --response and leaves the clipboard alone", async () => {
    const context = createContext([
      { role: "assistant", content: [{ type: "text", text: "```\nolder\n```" }] },
      { role: "assistant", content: [{ type: "text", text: "no fence here" }] },
      { role: "assistant", content: [{ type: "text", text: "```\nlatest\n```" }] },
    ] as Message[]);
    const text = async (args: string) => ((await copyCommand.execute(args, context)) as any).text;

    for (const bad of ["code x --response 3", "code 0 --response 3", "code 1.5 --response 3"]) {
      expect(await text(bad)).toBe("Invalid code block number. Expected a positive integer.");
    }
    for (const bad of ["code 1 --response", "code 1 --response 0", "code 1 --response x", "code --response 2 3"]) {
      expect(await text(bad)).toBe("Invalid response number. Expected a positive integer.");
    }
    expect(await text("code 1 --response 4")).toBe("Nothing to copy (only 3 assistant messages available).");
    expect(await text("code 2 --response 3")).toBe("Nothing to copy (only 1 fenced code block available in response -3).");
    expect(await text("code --response 2")).toBe("Nothing to copy (no complete fenced code blocks in response -2).");
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it("validates the code form before reporting an empty history", async () => {
    const context = createContext([{ role: "user", content: [{ type: "text", text: "hello" }] } as any]);
    const text = async (args: string) => ((await copyCommand.execute(args, context)) as any).text;

    expect(await text("code 1 --response 0")).toBe("Invalid response number. Expected a positive integer.");
    expect(await text("code 0")).toBe("Invalid code block number. Expected a positive integer.");
    for (const valid of ["code", "code 1 --response 2"]) {
      expect(await text(valid)).toBe("Nothing to copy (no assistant messages found).");
    }
    // Legacy /copy keeps answering with the empty history first.
    expect(await text("0")).toBe("Nothing to copy (no assistant messages found).");
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it("does not accept a would-be closing fence followed by a nonbreaking space", async () => {
    const context = createContext([
      { role: "assistant", content: [{ type: "text", text: "~~~js\nbody\n~~~\u00a0" }] },
    ] as Message[]);
    expect(await copyCommand.execute("code", context)).toEqual({
      type: "message", text: "Nothing to copy (no complete fenced code blocks in the latest response).",
    });
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "2e0", "1 extra", "9007199254740992"])("rejects invalid code block index %s", async (index) => {
    const context = createContext([
      { role: "assistant", content: [{ type: "text", text: "~~~\ncode\n~~~" }] },
    ] as Message[]);
    expect(await copyCommand.execute("code " + index, context)).toEqual({
      type: "message", text: "Invalid code block number. Expected a positive integer.",
    });
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
