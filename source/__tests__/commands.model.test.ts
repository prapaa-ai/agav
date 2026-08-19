import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/vertex-ai.js", () => ({
  fetchVertexAIModels: vi.fn(),
}));

const { fetchVertexAIModels } = await import("../providers/vertex-ai.js");
const fetchVertexAIModelsMock = vi.mocked(fetchVertexAIModels);
const { modelCommand } = await import("../commands/model.js");

import type { CommandContext } from "../commands/types.js";
import type { AgavConfig } from "../config/config.js";

const originalFetch = globalThis.fetch;

/**
 * Answer only the Anthropic listing; every other endpoint (Ollama in
 * particular) is treated as unreachable so the tests never touch the network.
 */
function stubFetch(anthropicModels: string[]): void {
  globalThis.fetch = vi.fn(async (input: any) => {
    if (String(input).includes("api.anthropic.com")) {
      return {
        ok: true,
        json: async () => ({ data: anthropicModels.map((id) => ({ id })) }),
      } as any;
    }
    throw new Error("unreachable");
  }) as any;
}

/** Narrow a CommandResult to the message text these tests assert on. */
function messageText(result: Awaited<ReturnType<typeof modelCommand.execute>>): string {
  expect(result.type).toBe("message");
  return result.type === "message" ? result.text : "";
}

function createContext(config: Partial<AgavConfig>): CommandContext {
  return {
    conversation: {} as any,
    config: { provider: "vertex-ai", model: "vertex/gemini-3.5-flash", ...config } as any,
    setModel: vi.fn(),
    setProvider: vi.fn(),
    setEffort: vi.fn(),
    clearMessages: vi.fn(),
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
    showAgentsTUI: vi.fn(),
  };
}

beforeEach(() => {
  fetchVertexAIModelsMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("commands/model", () => {
  it("lists Vertex AI models alongside the other providers", async () => {
    stubFetch([]);
    fetchVertexAIModelsMock.mockResolvedValue(["vertex/gemini-3.5-pro"]);

    const context = createContext({ vertexAICredentialsPath: "/tmp/sa.json", vertexAILocation: "us-east5" });
    const result = await modelCommand.execute("vertex/gemini-3.5-pro", context);

    expect(fetchVertexAIModelsMock).toHaveBeenCalledWith("/tmp/sa.json", "us-east5");
    expect(context.setModel).toHaveBeenCalledWith("vertex/gemini-3.5-pro");
    expect(messageText(result)).toContain("Model changed to: vertex/gemini-3.5-pro");
  });

  // A misread key file used to be swallowed, so /model just showed no Vertex
  // entries — indistinguishable from a provider that has nothing to offer.
  it("reports why Vertex AI produced no models instead of hiding the failure", async () => {
    stubFetch(["claude-sonnet-4-20250514"]);
    fetchVertexAIModelsMock.mockRejectedValue(
      new Error("Unable to read Vertex AI credentials from /tmp/sa.json: ENOENT"),
    );

    const context = createContext({
      anthropicApiKey: "test-key",
      vertexAICredentialsPath: "/tmp/sa.json",
    });
    const result = await modelCommand.execute("vertex/gemini-3.5-pro", context);

    expect(context.setModel).not.toHaveBeenCalled();
    expect(messageText(result)).toContain("not found");
    expect(messageText(result)).toContain("Vertex AI models unavailable");
    expect(messageText(result)).toContain("ENOENT");
  });

  it("surfaces the Vertex AI failure when it is the only configured provider", async () => {
    stubFetch([]);
    fetchVertexAIModelsMock.mockRejectedValue(new Error("missing required key: project_id"));

    const context = createContext({ vertexAICredentialsPath: "/tmp/sa.json" });
    const result = await modelCommand.execute("", context);

    expect(context.setPickerActive).not.toHaveBeenCalled();
    expect(messageText(result)).toContain("No providers reachable");
    expect(messageText(result)).toContain("missing required key: project_id");
  });

  it("does not query Vertex AI when no credentials path is configured", async () => {
    stubFetch(["claude-sonnet-4-20250514"]);

    const context = createContext({ anthropicApiKey: "test-key", vertexAICredentialsPath: undefined });
    const result = await modelCommand.execute("claude-sonnet-4-20250514", context);

    expect(fetchVertexAIModelsMock).not.toHaveBeenCalled();
    expect(messageText(result)).not.toContain("Vertex AI models unavailable");
  });
});
