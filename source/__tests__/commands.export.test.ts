import { mkdtemp, readFile, readdir, rm, stat, writeFile as realWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  open: vi.fn(), unlink: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(), homedir: () => "/home/ann",
}));

import { open, unlink } from "node:fs/promises";
import { exportCommand } from "../commands/export.js";
import { createHelpCommand } from "../commands/help.js";
import { ConversationState } from "../agent/conversation.js";
import { MAX_STEPS_PROMPT } from "../agent/internal-prompts.js";
import type { CommandContext, CommandResult } from "../commands/types.js";
import type { Message } from "../providers/types.js";

const now = new Date("2026-10-25T06:00:00.000Z");
const write = vi.fn();
const close = vi.fn();
const usage = { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 2 };
const messages = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
  { role: "assistant", content: [
    { type: "text", text: "Working" },
    { type: "tool_use", toolCallId: "call-1", toolName: "read_file", toolInput: { path: "a.ts" } },
  ] },
  { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", toolResult: "done", isError: false }] },
];

function context(input = messages(), compacted = false): CommandContext {
  return {
    conversation: { getMessages: () => input, wasCompacted: compacted },
    config: { model: "test-model", provider: "openai" },
    getDebugState: () => ({ tokenUsage: usage }),
  } as CommandContext;
}
function text(result: CommandResult): string {
  expect(result.type).toBe("message");
  return (result as Extract<CommandResult, { type: "message" }>).text;
}
function output(): string { return write.mock.calls[0][0]; }
function json() { return JSON.parse(output()); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  write.mockResolvedValue(undefined);
  close.mockResolvedValue(undefined);
  vi.mocked(open).mockResolvedValue({ writeFile: write, close } as unknown as Awaited<ReturnType<typeof open>>);
  vi.mocked(unlink).mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("export command", () => {
  it("preserves the existing default Markdown bytes", async () => {
    const result = await exportCommand.execute("", context());
    expect(output()).toBe([
      "# Agav Conversation\n", "**Model:** test-model  ", "**Provider:** openai  ",
      "**Date:** 2026-10-25T06:00:00.000Z\n", "---\n", "## You\n\nHello\n",
      "## Agav\n", "Working\n", '> **read_file** `{"path":"a.ts"}`\n',
      "> **Tool Result** (call-1): OK", "> ```\n> done\n> ```\n",
    ].join("\n"));
    expect(text(result)).toBe(`Exported to ${join(process.cwd(), `agav-export-${now.getTime()}.md`)}`);
    expect(result).toHaveProperty("preservePaths", true);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\.md$/), "wx", 0o600);
  });

  it("preserves JSON data, ordering and session usage without Markdown truncation", async () => {
    const input = messages();
    input[1].content[1].toolInput = { text: "x".repeat(800), number: 1, bool: false, nil: null, array: ["one"] };
    input[2].content[0].toolResult = "y".repeat(900);
    input[2].content[0].toolResultContent = [{ type: "text", text: "nested" }];
    input[0].sourceText = "original";
    input[0].displayText = "display";
    input[0].invocationReason = { source: "schedule", detail: "daily" };
    await exportCommand.execute("json", context(input));
    expect(json()).toEqual({
      schemaVersion: 1, model: "test-model", provider: "openai", exportedAt: now.toISOString(),
      scope: "retained-conversation", compacted: false, sanitized: false, tokenUsage: usage,
      omissions: { imagePayloads: 0, providerMetadata: 0 }, messages: input,
    });
    expect(output()).toMatch(/\n  "schemaVersion": 1,/);
    expect(output().endsWith("\n")).toBe(true);
  });

  it.each(["", "json", "sanitize", "json sanitize"])("filters internal prompts before rendering %s", async (args) => {
    const input: Message[] = [
      { role: "user", internal: true, content: [{ type: "text", text: "hidden internal" }] },
      { role: "user", content: [{ type: "text", text: MAX_STEPS_PROMPT }] },
      { role: "user", sourceText: MAX_STEPS_PROMPT, displayText: "user quotation", content: [{ type: "text", text: MAX_STEPS_PROMPT }] },
    ];
    await exportCommand.execute(args, context(input));
    expect(output()).not.toContain("hidden internal");
    if (args.includes("json")) expect(json().messages).toEqual([input[2]]);
    else expect(output()).toContain("user quotation");
  });

  it.each(["sanitize json", "json --sanitize", "--sanitize json", " json  sanitize sanitize "])("accepts composable options: %s", async (args) => {
    await exportCommand.execute(args, context());
    expect(json().sanitized).toBe(true);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/-sanitized\.json$/), "wx", 0o600);
  });

  it.each(["sanitise", "json --sanitise", "json --help unknown", "xml", "json /some/path"])("rejects unknown options without writing: %s", async (args) => {
    expect(text(await exportCommand.execute(args, context()))).toContain("Unknown export option");
    expect(open).not.toHaveBeenCalled();
  });

  it("provides identical detailed help through both help entry points", async () => {
    const direct = text(await exportCommand.execute("--help", context()));
    const help = createHelpCommand(() => [exportCommand]);
    expect(text(await help.execute("export", context()))).toContain(direct);
    expect(direct).toContain("Review before sharing");
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    { input: [] as Message[] },
    { input: [{ role: "user", internal: true, content: [{ type: "text", text: "internal" }] }] as Message[] },
  ])("does not write an empty filtered conversation", async ({ input }) => {
    expect(text(await exportCommand.execute("json", context(input)))).toBe("No messages to export.");
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps Markdown's display text, terminal-link stripping, errors and preview limits", async () => {
    const input = messages();
    input[0].displayText = "\x1b]8;;file:///tmp/a.ts\x1b\\a.ts\x1b]8;;\x1b\\";
    input[1].content[1].toolInput = { data: "x".repeat(400) };
    input[2].content[0].isError = true;
    input[2].content[0].toolResult = "y".repeat(800);
    await exportCommand.execute("", context(input));
    expect(output()).toContain("## You\n\na.ts\n");
    expect(output()).not.toContain("Hello");
    expect(output()).not.toContain("\x1b");
    expect(output()).toContain(`\`${JSON.stringify(input[1].content[1].toolInput).slice(0, 200)}\``);
    expect(output()).toContain("(call-1): ERROR");
    expect(output()).toContain("y".repeat(500));
    expect(output()).not.toContain("y".repeat(501));
  });

  it("sanitizes all projected text and nested inputs without mutating a frozen session", async () => {
    const secret = "gho_abcdefgh123456";
    const input: Message[] = [
      { role: "user", displayText: secret, sourceText: secret, invocationReason: { source: "watch", detail: secret }, content: [{ type: "text", text: secret }] },
      { role: "assistant", content: [{ type: "text", text: secret }, { type: "tool_use", toolCallId: "call-1", toolName: "test", toolInput: { nested: [{ apiKey: "tiny", path: "/home/ann/a.ts", value: secret }], count: 3 } }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", toolResult: secret, toolResultContent: [{ type: "text", text: secret }], isError: true }] },
    ];
    const before = structuredClone(input);
    await exportCommand.execute("json sanitize", context(freeze(input)));
    expect(input).toEqual(before);
    expect(output()).not.toMatch(/gho_abcdefgh123456|tiny|\/home\/ann/);
    expect(json().messages[1].content[1].toolInput).toEqual({ nested: [{ apiKey: "***REDACTED***", path: "~/a.ts", value: "***REDACTED***" }], count: 3 });
    expect(json().messages[2].content[0]).toMatchObject({ toolCallId: "call-1", isError: true });
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 2 });
  });

  it("redacts before Markdown previews truncate a secret", async () => {
    const input = messages();
    input[1].content[1].toolInput = { text: "a".repeat(183) + " sk-abcdefgh123456789" };
    input[2].content[0].toolResult = "b".repeat(496) + " sk-abcdefgh123456789";
    await exportCommand.execute("sanitize", context(input));
    expect(output()).not.toContain("sk-");
    expect(output()).toContain("***");
    expect(input[2].content[0].toolResult).toContain("sk-abcdefgh");
  });

  it.each(["sanitize", "json sanitize"])("redacts credentials after empty assignments in messages and tool output (%s)", async (args) => {
    const input = messages();
    input[0].content[0].text = 'OPENAI_API_KEY=\nCLIENT_SECRET = "ordinary-secret-value"';
    input[2].content[0].toolResult = "api_key:\r\npassword: ordinary-secret-value";
    await exportCommand.execute(args, context(input));
    expect(output()).not.toContain("ordinary-secret-value");
    if (args.includes("json")) {
      expect(json().messages[0].content[0].text).toBe('OPENAI_API_KEY=\nCLIENT_SECRET = "***REDACTED***"');
      expect(json().messages[2].content[0].toolResult).toBe("api_key:\r\npassword: ***REDACTED***");
    } else {
      expect(output()).toContain('OPENAI_API_KEY=\nCLIENT_SECRET = "***REDACTED***"');
      expect(output()).toContain("api_key:\r\npassword: ***REDACTED***");
    }
  });

  it.each([false, true])("handles images and opaque provider state (sanitized=%s)", async (sanitize) => {
    const image = { type: "image" as const, imageData: "c2VjcmV0", imageMediaType: "image/png", imageWidth: 20, imageHeight: 10 };
    const input: Message[] = [{ role: "user", content: [
      image,
      { type: "tool_result", toolCallId: "call-1", toolResult: "image", toolResultContent: [image], providerMetadata: { hidden: "opaque-secret" } },
    ] }];
    const result = await exportCommand.execute(sanitize ? "json sanitize" : "json", context(input));
    expect(output()).not.toContain("opaque-secret");
    expect(json().omissions).toEqual({ imagePayloads: sanitize ? 2 : 0, providerMetadata: 1 });
    expect(json().messages[0].content[0]).toEqual(sanitize
      ? { type: "image", imageDataOmitted: true, imageMediaType: "image/png", imageWidth: 20, imageHeight: 10 }
      : image);
    if (sanitize) {
      expect(output()).not.toContain("c2VjcmV0");
      expect(text(result)).toContain("Omitted 2 image payload(s)");
    }
  });

  it("reports retained scope after real compaction and omits unavailable usage", async () => {
    const conversation = new ConversationState();
    for (let i = 0; i < 12; i++) {
      conversation.addUserMessage(`question ${i} ` + "x".repeat(500));
      conversation.addAssistantMessage([{ type: "text", text: `answer ${i}` }]);
    }
    await conversation.compactIfNeeded(true);
    const ctx = context();
    ctx.conversation = conversation;
    ctx.getDebugState = vi.fn();
    const result = await exportCommand.execute("json", ctx);
    expect(json().compacted).toBe(true);
    expect(json()).not.toHaveProperty("tokenUsage");
    expect(json().messages.every((m: Message) => !m.internal)).toBe(true);
    expect(text(result)).toContain("Earlier messages were compacted");
  });

  it("fails before opening a file for unserializable data", async () => {
    const input = messages();
    input[1].content[1].toolInput = { invalid: BigInt(1) };
    expect(text(await exportCommand.execute("json", context(input)))).toContain("No export file was created");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("export file lifecycle", () => {
  it.each(["EACCES", "EROFS", "ENOSPC", "ENOENT"])("handles %s without exposing exception details or deleting existing files", async (code) => {
    vi.mocked(open).mockRejectedValue(Object.assign(new Error("secret value"), { code }));
    const result = text(await exportCommand.execute("json", context()));
    expect(result).toContain("Could not save");
    expect(result).not.toContain("secret value");
    expect(unlink).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("bounds filename collision retries and never deletes collided files", async () => {
    vi.mocked(open).mockRejectedValue(Object.assign(new Error(), { code: "EEXIST" }));
    expect(text(await exportCommand.execute("", context()))).toContain("filenames are already in use");
    expect(open).toHaveBeenCalledTimes(10);
    expect(unlink).not.toHaveBeenCalled();
  });

  it.each(["write", "close"])("cleans up its partial file after a %s failure", async (phase) => {
    (phase === "write" ? write : close).mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "ENOSPC" }));
    const result = text(await exportCommand.execute("json sanitize", context()));
    expect(result).toContain("Free some disk space");
    expect(unlink).toHaveBeenCalledWith(vi.mocked(open).mock.calls[0][0]);
    expect(result).not.toContain("secret");
  });

  it("identifies a partial file when cleanup also fails", async () => {
    write.mockRejectedValue(new Error("secret"));
    vi.mocked(unlink).mockRejectedValue(Object.assign(new Error(), { code: "EPERM" }));
    const result = text(await exportCommand.execute("json", context()));
    expect(result).toContain("partial file may remain");
    expect(result).toContain(String(vi.mocked(open).mock.calls[0][0]));
    expect(result).not.toContain("secret");
  });

  it("waits for the write before reporting success", async () => {
    let finish!: () => void;
    write.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    let completed = false;
    const task = exportCommand.execute("json", context()).then((result) => { completed = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    expect(text(await task)).toContain("Exported JSON");
  });

  it("uses exclusive creation on real files, preserves collisions and writes private files", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "agav-export-test-"));
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    vi.mocked(open).mockImplementation(actual.open);
    vi.mocked(unlink).mockImplementation(actual.unlink);
    try {
      const original = join(directory, `agav-export-${now.getTime()}.json`);
      await realWriteFile(original, "existing file");
      const result = await exportCommand.execute("json", context());
      const destination = join(directory, `agav-export-${now.getTime()}-1.json`);
      expect(text(result)).toContain(destination);
      expect(await readFile(original, "utf8")).toBe("existing file");
      expect(JSON.parse(await readFile(destination, "utf8")).messages).toEqual(messages());
      if (process.platform !== "win32") expect((await stat(destination)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toHaveLength(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
