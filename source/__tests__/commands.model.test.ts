import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/vertex-ai.js", () => ({
  fetchVertexAIModels: vi.fn(),
}));

const { fetchVertexAIModels } = await import("../providers/vertex-ai.js");
const fetchVertexAIModelsMock = vi.mocked(fetchVertexAIModels);
const { fetchAvailableModels, findMatchingModels, modelCommand } = await import("../commands/model.js");

import type { CommandContext } from "../commands/types.js";
import type { AgavConfig } from "../config/config.js";

const originalFetch = globalThis.fetch;

/**
 * Answer Anthropic and OpenRouter listings; every other endpoint (Ollama in
 * particular) is treated as unreachable so the tests never touch the network.
 */
function stubFetch(anthropicModels: string[] = [], openrouterModels: string[] = []): void {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("api.anthropic.com")) {
      return {
        ok: true,
        json: async () => ({ data: anthropicModels.map((id) => ({ id })) }),
      } as any;
    }
    if (url.includes("openrouter.ai/api/v1/models")) {
      return {
        ok: true,
        json: async () => ({ data: openrouterModels.map((id) => ({ id })) }),
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
  };
}

beforeEach(() => {
  fetchVertexAIModelsMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("commands/model", () => {
  it("matches a bare model against OpenRouter's provider-prefixed catalog name", async () => {
    stubFetch([], ["openai/gpt-5.6-sol"]);

    const { models } = await fetchAvailableModels({
      ...createContext({ provider: "openai", openaiApiKey: "openai-key", openrouterApiKey: "openrouter-key" }).config,
    });

    expect(findMatchingModels(models, "gpt-5.6-sol")).toEqual([
      { id: "openai/gpt-5.6-sol", provider: "openrouter" },
    ]);
  });

  it("returns every provider for a bare model that OpenAI and OpenRouter both offer", async () => {
    stubFetch([], ["openai/gpt-5.6-sol"]);
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("api.openai.com")) {
        return { ok: true, json: async () => ({ data: [{ id: "gpt-5.6-sol" }] }) } as any;
      }
      if (url.includes("openrouter.ai/api/v1/models")) {
        return { ok: true, json: async () => ({ data: [{ id: "openai/gpt-5.6-sol" }] }) } as any;
      }
      throw new Error("unreachable");
    }) as any;

    const { models } = await fetchAvailableModels({
      ...createContext({ openaiApiKey: "openai-key", openrouterApiKey: "openrouter-key" }).config,
    });

    expect(findMatchingModels(models, "gpt-5.6-sol")).toEqual([
      { id: "gpt-5.6-sol", provider: "openai" },
      { id: "openai/gpt-5.6-sol", provider: "openrouter" },
    ]);
  });

  it("discovers OpenAI models via the org gateway when gateway auth is present (no personal key)", async () => {
    // Reviewer scenario: enrolled developer has gateway auth + an OpenRouter key.
    // Discovery must query the gateway (not api.openai.com) and surface the OpenAI
    // model so --model routing does not switch away to OpenRouter.
    const seen: { url: string; auth?: string }[] = [];
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
      seen.push({ url, auth });
      if (url.includes("gateway.corp")) {
        return { ok: true, json: async () => ({ data: [{ id: "gpt-4o" }] }) } as any;
      }
      if (url.includes("openrouter.ai/api/v1/models")) {
        return { ok: true, json: async () => ({ data: [{ id: "openai/gpt-4o" }] }) } as any;
      }
      // Ollama fallback and anything else: empty.
      return { ok: true, json: async () => ({ data: [] }) } as any;
    }) as any;

    const { models } = await fetchAvailableModels({
      ...createContext({
        openrouterApiKey: "openrouter-key",
        openaiApiKey: undefined,
        openaiGatewayAuth: true,
        openaiBaseURL: "https://gateway.corp/v1",
        openaiHeaders: { Authorization: "Bearer gw-secret" },
      }).config,
    });

    // The OpenAI gateway was queried (not the public endpoint) with the gw token.
    expect(seen.some((r) => r.url.startsWith("https://gateway.corp/v1/models"))).toBe(true);
    expect(seen.some((r) => r.url.includes("api.openai.com"))).toBe(false);
    expect(seen.find((r) => r.url.includes("gateway.corp"))?.auth).toBe("Bearer gw-secret");
    // Both the gateway OpenAI model and the OpenRouter variant are discovered.
    expect(findMatchingModels(models, "gpt-4o")).toEqual([
      { id: "gpt-4o", provider: "openai" },
      { id: "openai/gpt-4o", provider: "openrouter" },
    ]);
  });

  it("preserves gateway model aliases that the public OpenAI filter would discard", async () => {
    // A gateway returns the org's own catalog; non-public IDs must survive.
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("gateway.corp")) {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "gpt-4o" }, { id: "corp-coder" }, { id: "anthropic/claude-sonnet-4" }] }),
        } as any;
      }
      return { ok: true, json: async () => ({ data: [] }) } as any;
    }) as any;

    const { models } = await fetchAvailableModels({
      ...createContext({
        openaiApiKey: undefined,
        openaiGatewayAuth: true,
        openaiBaseURL: "https://gateway.corp/v1",
        openaiHeaders: { Authorization: "Bearer gw-secret" },
      }).config,
    });

    const ids = models.filter((m) => m.provider === "openai").map((m) => m.id).sort();
    expect(ids).toEqual(["anthropic/claude-sonnet-4", "corp-coder", "gpt-4o"]);
    expect(findMatchingModels(models, "corp-coder")).toEqual([{ id: "corp-coder", provider: "openai" }]);
  });

  it("still filters the PUBLIC OpenAI endpoint to chat models by name", async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("api.openai.com")) {
        return { ok: true, json: async () => ({ data: [{ id: "gpt-4o" }, { id: "whisper-1" }, { id: "text-embedding-3-small" }] }) } as any;
      }
      return { ok: true, json: async () => ({ data: [] }) } as any;
    }) as any;

    const { models } = await fetchAvailableModels({
      ...createContext({ openaiApiKey: "openai-key" }).config,
    });
    const ids = models.filter((m) => m.provider === "openai").map((m) => m.id);
    expect(ids).toEqual(["gpt-4o"]); // whisper + embeddings filtered out
  });

  it("builds the gateway /models URL preserving the query string", async () => {
    let requestedUrl = "";
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("gateway.corp")) {
        requestedUrl = url;
        return { ok: true, json: async () => ({ data: [{ id: "corp-coder" }] }) } as any;
      }
      return { ok: true, json: async () => ({ data: [] }) } as any;
    }) as any;

    await fetchAvailableModels({
      ...createContext({
        openaiApiKey: undefined,
        openaiGatewayAuth: true,
        openaiBaseURL: "https://gateway.corp/v1?tenant=team-a",
        openaiHeaders: { Authorization: "Bearer gw-secret" },
      }).config,
    });

    // /models goes in the path, query is preserved — not `/v1?tenant=team-a/models`.
    expect(requestedUrl).toBe("https://gateway.corp/v1/models?tenant=team-a");
  });

  it("returns every provider for an ambiguous model so startup can prompt for a choice", async () => {
    stubFetch(["shared-model"], ["shared-model"]);

    const { models } = await fetchAvailableModels({
      ...createContext({ anthropicApiKey: "anthropic-key", openrouterApiKey: "openrouter-key" }).config,
    });

    expect(models.filter((candidate) => candidate.id === "shared-model").map((candidate) => candidate.provider))
      .toEqual(["anthropic", "openrouter"]);
  });

  it("returns no candidates for an unavailable model", async () => {
    stubFetch(["claude-sonnet"], ["anthropic/claude-sonnet"]);

    const { models } = await fetchAvailableModels({
      ...createContext({ anthropicApiKey: "anthropic-key", openrouterApiKey: "openrouter-key" }).config,
    });

    expect(models.filter((candidate) => candidate.id === "missing-model")).toEqual([]);
  });

  it("lists Vertex AI models alongside the other providers", async () => {
    stubFetch([]);
    fetchVertexAIModelsMock.mockResolvedValue(["vertex/gemini-3.5-pro"]);

    const context = createContext({ vertexAICredentialsPath: "/tmp/sa.json", vertexAILocation: "us-east5" });
    const result = await modelCommand.execute("vertex/gemini-3.5-pro", context);

    expect(fetchVertexAIModelsMock).toHaveBeenCalledWith("/tmp/sa.json", "us-east5");
    expect(context.setModel).toHaveBeenCalledWith("vertex/gemini-3.5-pro");
    expect(messageText(result)).toContain("Model changed to: vertex/gemini-3.5-pro");
  });

  it("matches a bare Vertex Gemini model to its canonical catalog identifier", async () => {
    stubFetch([]);
    fetchVertexAIModelsMock.mockResolvedValue(["vertex/gemini-3.6-flash"]);

    const context = createContext({ provider: "openai", vertexAICredentialsPath: "/tmp/sa.json" });
    const result = await modelCommand.execute("gemini-3.6-flash", context);

    expect(context.setModel).toHaveBeenCalledWith("gemini-3.6-flash");
    expect(context.setProvider).toHaveBeenCalledWith("vertex-ai");
    expect(messageText(result)).toContain("switched to vertex-ai");
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

  it("lists OpenRouter models and auto-switches provider when an OpenRouter model is selected", async () => {
    stubFetch([], ["anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat-v3.1"]);

    const context = createContext({
      provider: "anthropic",
      openrouterApiKey: "sk-or-v1-test",
    });
    const result = await modelCommand.execute("deepseek/deepseek-chat-v3.1", context);

    expect(context.setModel).toHaveBeenCalledWith("deepseek/deepseek-chat-v3.1");
    expect(context.setProvider).toHaveBeenCalledWith("openrouter");
    expect(messageText(result)).toContain("Model changed to: deepseek/deepseek-chat-v3.1 (switched to openrouter)");
  });

  it("rejects an out-of-policy pair atomically — neither provider nor model is changed", async () => {
    stubFetch([], ["anthropic/claude-sonnet-4.5"]);

    const context = createContext({
      provider: "openai",
      model: "gpt-5.4",
      openaiApiKey: "k",
      openrouterApiKey: "sk-or-v1-test",
      orgAllowedModels: ["gpt-5.4"],
    });
    const result = await modelCommand.execute("anthropic/claude-sonnet-4.5", context);

    expect(messageText(result)).toContain("not permitted by your organization");
    // Atomic: a rejected model must not leave a changed provider behind.
    expect(context.setProvider).not.toHaveBeenCalled();
    expect(context.setModel).not.toHaveBeenCalled();
  });

  it("keeps the direct provider for an OpenRouter slug with the same provider prefix", async () => {
    stubFetch([], ["anthropic/claude-sonnet-4.5"]);

    const context = createContext({
      provider: "anthropic",
      openrouterApiKey: "sk-or-v1-test",
    });
    const result = await modelCommand.execute("anthropic/claude-sonnet-4.5", context);

    expect(context.setModel).toHaveBeenCalledWith("anthropic/claude-sonnet-4.5");
    expect(context.setProvider).not.toHaveBeenCalled();
    expect(messageText(result)).toBe("Model changed to: anthropic/claude-sonnet-4.5");
  });

  it("swallows OpenRouter API errors gracefully when fetching models", async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).includes("openrouter.ai")) {
        return { ok: false, status: 500 } as any;
      }
      throw new Error("unreachable");
    }) as any;

    const context = createContext({ openrouterApiKey: "sk-or-v1-test" });
    const result = await modelCommand.execute("", context);

    expect(messageText(result)).toContain("No providers reachable");
  });
});
