import { describe, it, expect } from "vitest";
import type { Message } from "../providers/types.js";
import {
  NEEDS_VERIFY_PROMPT,
  MAX_STEPS_PROMPT,
  isInternalUserMessage,
  testsFailedPrompt,
} from "../agent/internal-prompts.js";
import { ConversationState } from "../agent/conversation.js";
import { messagesToDisplay } from "../hooks/use-agent.js";

const userMessage = (text: string, extra: Partial<Message> = {}): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  ...extra,
});

describe("internal user messages", () => {
  it("recognises a flagged message whatever it says", () => {
    const conversation = new ConversationState();
    conversation.addInternalUserMessage("anything at all");
    expect(isInternalUserMessage(conversation.getMessages()[0]!)).toBe(true);
  });

  // Sessions written before the flag existed carry no marker, so the only
  // handle on them is the text the loop injected.
  it("recognises unflagged injections in sessions saved before the flag", () => {
    expect(isInternalUserMessage(userMessage(NEEDS_VERIFY_PROMPT))).toBe(true);
    expect(isInternalUserMessage(userMessage(MAX_STEPS_PROMPT))).toBe(true);
    expect(isInternalUserMessage(userMessage(testsFailedPrompt(2, 3)))).toBe(true);
    expect(isInternalUserMessage(userMessage("[Earlier conversation (4 exchanges) was compacted"))).toBe(true);
  });

  // Text matching is a fallback for old sessions only — a user is free to
  // paste one of these strings back in, and that turn is theirs.
  it("leaves a real user turn alone even when it quotes an injected prompt", () => {
    expect(isInternalUserMessage(userMessage(NEEDS_VERIFY_PROMPT, { sourceText: NEEDS_VERIFY_PROMPT }))).toBe(false);
    expect(isInternalUserMessage(userMessage("why did you say: " + NEEDS_VERIFY_PROMPT))).toBe(false);
  });

  it("never treats an assistant turn as internal", () => {
    expect(isInternalUserMessage({ role: "assistant", content: [{ type: "text", text: MAX_STEPS_PROMPT }] })).toBe(false);
  });

  it("flags the compaction summary so it is not shown as something the user said", async () => {
    const conversation = new ConversationState();
    for (let i = 0; i < 12; i++) {
      conversation.addUserMessage(`turn ${i} `.repeat(400));
      conversation.addAssistantMessage([{ type: "text", text: `reply ${i} `.repeat(400) }]);
    }

    const result = await conversation.compactIfNeeded(true);
    expect(result.compacted).toBe(true);
    expect(isInternalUserMessage(conversation.getMessages()[0]!)).toBe(true);
  });
});

describe("messagesToDisplay", () => {
  // The reported bug: resuming after an abrupt exit printed the verification
  // re-prompt as though the user had typed it, right under their own prompt.
  it("omits prompts the agent injected to steer itself", () => {
    const conversation = new ConversationState();
    conversation.addUserMessage("refactor the auth module", undefined, "refactor the auth module", "refactor the auth module");
    conversation.addAssistantMessage([{ type: "text", text: "Done." }]);
    conversation.addInternalUserMessage(NEEDS_VERIFY_PROMPT);
    conversation.addAssistantMessage([{ type: "text", text: "Verified." }]);

    expect(messagesToDisplay(conversation.getMessages()).map((m) => m.content)).toEqual([
      "refactor the auth module",
      "Done.",
      "Verified.",
    ]);
  });

  it("omits unflagged injections restored from an older session file", () => {
    const restored: Message[] = [
      userMessage("fix the parser", { displayText: "fix the parser", sourceText: "fix the parser" }),
      { role: "assistant", content: [{ type: "text", text: "Fixed." }] },
      userMessage(NEEDS_VERIFY_PROMPT),
    ];
    expect(messagesToDisplay(restored).map((m) => m.content)).toEqual(["fix the parser", "Fixed."]);
  });

  // Per-turn context is appended to the user's message as a second text block,
  // so rendering every block would print the environment dump under the prompt.
  it("shows a user turn as typed, not as sent", () => {
    const conversation = new ConversationState();
    conversation.addUserMessage("explain @src/a.ts", undefined, "explain @src/a.ts", "explain @src/a.ts");
    conversation.appendToLastUserMessage("<turn-context>cwd: /repo</turn-context>");

    expect(messagesToDisplay(conversation.getMessages()).map((m) => m.content)).toEqual(["explain @src/a.ts"]);
  });

  // The headless path records sourceText but no displayText; without it the
  // transcript would show the prompt with its @mentions already expanded.
  it("falls back to the source text when there is no display text", () => {
    const restored: Message[] = [userMessage("read the file <contents...>", { sourceText: "read @a.ts" })];
    expect(messagesToDisplay(restored).map((m) => m.content)).toEqual(["read @a.ts"]);
  });
});
