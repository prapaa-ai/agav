import { describe, expect, it, vi } from "vitest";
import { createPromptCommand } from "../mcp/prompt-command.js";
import type { MCPPrompt } from "../mcp/types.js";
import type { MCPManager } from "../mcp/manager.js";
import type { CommandContext } from "../commands/types.js";

function makeManager(text = "Rendered prompt"): MCPManager {
  return {
    getPrompt: vi.fn(async () => ({
      messages: [{ role: "user", content: { type: "text", text } }],
    })),
  } as unknown as MCPManager;
}

const dummyContext = {} as CommandContext;

describe("mcp/prompt-command", () => {
  it("builds argumentHint from required and optional arguments", () => {
    const prompt: MCPPrompt = {
      name: "review",
      serverName: "github",
      description: "Review a PR",
      arguments: [
        { name: "repo", required: true },
        { name: "pr", required: true },
        { name: "focus", required: false },
      ],
    };

    const cmd = createPromptCommand(prompt, makeManager());
    expect(cmd.argumentHint).toBe("<repo> <pr> [focus]");
  });

  it("omits argumentHint when the prompt declares no arguments", () => {
    const prompt: MCPPrompt = {
      name: "status",
      serverName: "github",
    };

    const cmd = createPromptCommand(prompt, makeManager());
    expect(cmd.argumentHint).toBeUndefined();
  });

  it("returns a local usage message naming missing required arguments without calling the server", async () => {
    const manager = makeManager();
    const prompt: MCPPrompt = {
      name: "review",
      serverName: "github",
      arguments: [
        { name: "repo", required: true },
        { name: "pr", required: true },
        { name: "focus", required: false },
      ],
    };

    const cmd = createPromptCommand(prompt, manager);
    const result = await cmd.execute("my-repo", dummyContext);

    expect(manager.getPrompt).not.toHaveBeenCalled();
    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("pr");
      expect(result.text).toContain("/review <repo> <pr> [focus]");
    }
  });

  it("maps positional arguments and allows optional arguments to be omitted", async () => {
    const manager = makeManager("Reviewing my-repo #42");
    const prompt: MCPPrompt = {
      name: "review",
      serverName: "github",
      arguments: [
        { name: "repo", required: true },
        { name: "pr", required: true },
        { name: "focus", required: false },
      ],
    };

    const cmd = createPromptCommand(prompt, manager);
    const result = await cmd.execute("my-repo 42", dummyContext);

    expect(manager.getPrompt).toHaveBeenCalledWith("github", "review", {
      repo: "my-repo",
      pr: "42",
    });
    expect(result).toEqual({ type: "submit", text: "Reviewing my-repo #42" });
  });
});
