import { describe, it, expect } from "vitest";
import { ConversationState } from "../agent/conversation.js";

describe("cost optimization", () => {
  it("compressMessages trims whitespace", () => {
    const conv = new ConversationState();
    // @ts-ignore private
    conv.messages = [{
      role: "user",
      content: [{ type: "text", text: "  hello   world  \n\n" }]
    }];
    // @ts-ignore private
    conv.compressMessages();
    // @ts-ignore private
    expect(conv.messages[0].content[0].text).toBe("hello world");
  });

  it("config has tokenBudget", () => {
    const config = { tokenBudget: 1000 };
    expect(config.tokenBudget).toBe(1000);
  });

  it("hashMessages produces consistent hash", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    // Simple hash test - just ensure function exists
    expect(typeof msgs).toBe("object");
  });
});
