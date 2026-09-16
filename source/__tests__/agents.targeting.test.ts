import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentDefinition } from "../agents/types.js";
import type { ContentBlock } from "../agent/conversation.js";

vi.mock("../agent/loop.js", () => ({
  runAgentLoop: vi.fn(async function* (options: { conversation: import("../agent/conversation.js").ConversationState }) {
    yield { type: "assistant_message_complete", text: "agent response" };
  }),
}));

vi.mock("../agents/a2a-client.js", () => ({
  executeA2AAgent: vi.fn().mockResolvedValue("a2a response"),
}));

import { executeTargetedAgent } from "../agents/targeting.js";
import { runAgentLoop } from "../agent/loop.js";
import { executeA2AAgent as mockA2AExecute } from "../agents/a2a-client.js";

describe("agents/targeting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards extraBlocks to executeNativeAgent and conversation.addUserMessage", async () => {
    const agent: AgentDefinition = {
      manifest: { name: "test-native", description: "Test Native Agent", version: "1.0.0", type: "native" },
      systemPrompt: "System prompt",
      tools: [],
      origin: "bundled",
      path: "/fake/path",
    };

    const extraBlocks: ContentBlock[] = [
      { type: "image", imageData: "data:image/png;base64,abc", imageMediaType: "image/png" },
    ];

    const result = await executeTargetedAgent(agent, "Analyze this image", {
      provider: {} as any,
      config: { model: "mock-model" } as any,
      extraBlocks,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe("agent response");

    const loopMock = vi.mocked(runAgentLoop);
    expect(loopMock).toHaveBeenCalledOnce();

    const callArgs = loopMock.mock.calls[0][0];
    const messages = callArgs.conversation.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      { type: "text", text: "Analyze this image" },
      { type: "image", imageData: "data:image/png;base64,abc", imageMediaType: "image/png" },
    ]);
  });

  it("executes targeted native agent without extraBlocks", async () => {
    const agent: AgentDefinition = {
      manifest: { name: "test-native", description: "Test Native Agent", version: "1.0.0", type: "native" },
      systemPrompt: "System prompt",
      tools: [],
      origin: "bundled",
      path: "/fake/path",
    };

    const result = await executeTargetedAgent(agent, "Simple query", {
      provider: {} as any,
      config: { model: "mock-model" } as any,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe("agent response");

    const loopMock = vi.mocked(runAgentLoop);
    expect(loopMock).toHaveBeenCalledOnce();

    const callArgs = loopMock.mock.calls[0][0];
    const messages = callArgs.conversation.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      { type: "text", text: "Simple query" },
    ]);
  });

  it("forwards extraBlocks to executeA2AAgent for a2a agent", async () => {
    const agent: AgentDefinition = {
      manifest: { name: "test-a2a", description: "Test A2A Agent", version: "1.0.0", type: "a2a" },
      systemPrompt: "System prompt",
      tools: [],
      origin: "bundled",
      path: "/fake/path",
    };

    const extraBlocks: ContentBlock[] = [
      { type: "image", imageData: "data:image/png;base64,xyz", imageMediaType: "image/png" },
    ];

    const result = await executeTargetedAgent(agent, "Analyze image with a2a", {
      provider: {} as any,
      config: { model: "mock-model" } as any,
      extraBlocks,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe("a2a response");

    expect(mockA2AExecute).toHaveBeenCalledWith(agent, "Analyze image with a2a", undefined, extraBlocks);
  });

  it("executes targeted a2a agent without extraBlocks", async () => {
    const agent: AgentDefinition = {
      manifest: { name: "test-a2a", description: "Test A2A Agent", version: "1.0.0", type: "a2a" },
      systemPrompt: "System prompt",
      tools: [],
      origin: "bundled",
      path: "/fake/path",
    };

    const result = await executeTargetedAgent(agent, "Simple query", {
      provider: {} as any,
      config: { model: "mock-model" } as any,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe("a2a response");

    expect(mockA2AExecute).toHaveBeenCalledWith(agent, "Simple query", undefined, undefined);
  });
});
