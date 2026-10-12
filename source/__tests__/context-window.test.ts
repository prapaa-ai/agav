import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationState } from "../agent/conversation.js";
import { DEFAULT_UNKNOWN_CONTEXT_WINDOW, runAgentLoop } from "../agent/loop.js";
import { contextCommand } from "../commands/context.js";
import type { CommandContext } from "../commands/types.js";
import { OpenRouterProvider } from "../providers/openrouter.js";
import { ToolRegistry } from "../tools/registry.js";

vi.mock("../utils/system-prompt.js", () => ({ buildSystemPrompt: async () => "system" }));
vi.mock("../skills/loader.js", () => ({ getCachedSkills: () => [], buildSkillCatalog: () => "" }));

const model = "stealth/unknown";
const ttl = 5 * 60 * 1000 + 1;

function setup() {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  vi.stubGlobal("fetch", fetch);
  vi.useFakeTimers();
  const provider = new OpenRouterProvider("test-key");
  vi.spyOn(provider, "stream").mockImplementation(async function* () {
    yield { type: "text_delta", text: "done" };
    yield { type: "message_end", stopReason: "end_turn" };
  });
  const conversation = new ConversationState();
  conversation.setModel(model);
  const toolRegistry = new ToolRegistry();
  const turn = async (requestManualContextWindow?: (model: string) => Promise<number | undefined>, signal?: AbortSignal, selectedModel = model) => {
    conversation.setModel(selectedModel);
    conversation.addUserMessage("hello");
    const events = [];
    for await (const event of runAgentLoop({
      provider, conversation, toolRegistry, model: selectedModel,
      iterationsBudget: { remaining: 2, total: 2 }, requestManualContextWindow, signal,
    })) events.push(event);
    return events;
  };
  return { provider, conversation, toolRegistry, fetch, turn };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("assumed context windows", () => {
  it.each(["dismissed", "zero", "rejected", "noninteractive"])("refreshes a %s default after the catalog TTL without repeated prompts", async (mode) => {
    const { conversation, fetch, turn } = setup();
    const prompt = vi.fn(async () => {
      if (mode === "rejected") throw new Error("prompt unavailable");
      return mode === "zero" ? 0 : undefined;
    });
    const request = mode === "noninteractive" ? undefined : prompt;
    await turn(request);
    expect(conversation.getContextWindow()).toBe(DEFAULT_UNKNOWN_CONTEXT_WINDOW);
    expect(conversation.getManualContextWindow(model)).toBeUndefined();
    await turn(request);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(mode === "noninteractive" ? 0 : 1);

    vi.advanceTimersByTime(ttl);
    await turn(request); // A refreshed catalog still missing the model must not re-prompt.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(conversation.getContextWindow()).toBe(DEFAULT_UNKNOWN_CONTEXT_WINDOW);
    expect(prompt).toHaveBeenCalledTimes(mode === "noninteractive" ? 0 : 1);

    fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: model, context_length: 32_768 }] }) });
    vi.advanceTimersByTime(ttl);
    await turn(request);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(conversation.getContextWindow()).toBe(32_768);
    expect(prompt).toHaveBeenCalledTimes(mode === "noninteractive" ? 0 : 1);
  });

  it("remembers dismissal per model across switches, but not across conversations", async () => {
    const { conversation, turn } = setup();
    const prompt = vi.fn(async (_model: string) => undefined);
    await turn(prompt);
    await turn(prompt, undefined, "stealth/other");
    await turn(prompt);
    expect(prompt.mock.calls.map(call => call[0])).toEqual([model, "stealth/other"]);
    expect(conversation.getContextWindow()).toBe(DEFAULT_UNKNOWN_CONTEXT_WINDOW);
    const other = setup();
    await other.turn(prompt);
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it("retains an assumed fallback on transient metadata failure and retries discovery", async () => {
    const { conversation, fetch, turn } = setup();
    const prompt = vi.fn(async () => undefined);
    await turn(prompt);
    fetch.mockRejectedValueOnce(new Error("offline"));
    vi.advanceTimersByTime(ttl);
    await turn(prompt);
    expect(conversation.getContextWindow()).toBe(DEFAULT_UNKNOWN_CONTEXT_WINDOW);
    expect(conversation.getManualContextWindow(model)).toBeUndefined();
    await turn(prompt);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it.each([32_768, DEFAULT_UNKNOWN_CONTEXT_WINDOW])("keeps an explicit %i override authoritative across turns and model switches", async (tokens) => {
    const { conversation, provider, turn } = setup();
    const lookup = vi.spyOn(provider, "getContextWindow");
    const prompt = vi.fn(async () => tokens);
    await turn(prompt);
    expect(conversation.getManualContextWindow(model)).toBe(tokens);
    conversation.setModel("other");
    vi.advanceTimersByTime(ttl);
    await turn(prompt);
    expect(conversation.getContextWindow()).toBe(tokens);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("does not remember an aborted prompt as a dismissal or manual override", async () => {
    const { conversation, provider, turn } = setup();
    const controller = new AbortController();
    const prompt = vi.fn(async () => { controller.abort(); return undefined; });
    expect(await turn(prompt, controller.signal)).toEqual([{ type: "error", error: new Error("Aborted") }]);
    expect(conversation.getManualContextWindow(model)).toBeUndefined();
    expect(conversation.getContextWindow()).toBeUndefined();
    expect(provider.stream).not.toHaveBeenCalled();
    const retry = vi.fn(async () => 32_768);
    await turn(retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(conversation.getContextWindow()).toBe(32_768);
  });

  it("does not prompt or save an override for an unconfirmed catalog failure", async () => {
    const { conversation, fetch, turn } = setup();
    fetch.mockRejectedValue(new Error("offline"));
    const prompt = vi.fn(async () => undefined);
    await turn(prompt);
    expect(prompt).not.toHaveBeenCalled();
    expect(conversation.getContextWindow()).toBeUndefined();
    expect(conversation.getManualContextWindow(model)).toBeUndefined();
  });
});

describe("/context manual override precedence", () => {
  function commandSetup() {
    const state = setup();
    const context = {
      ...state,
      config: { model, provider: "openrouter" },
      getDebugState: () => ({ mcpServers: [] }),
    } as unknown as CommandContext;
    return { ...state, context };
  }

  it.each(["reported", "missing", "unavailable"])("restores a saved manual window after switching back with %s metadata", async (metadata) => {
    const { conversation, provider, context } = commandSetup();
    conversation.setManualContextWindow(model, 32_768);
    conversation.setContextWindow(32_768);
    conversation.setModel("other");
    conversation.setModel(model);
    expect(conversation.getContextWindow()).toBeUndefined();
    const lookup = vi.spyOn(provider, "getContextWindow").mockResolvedValue(metadata === "reported" ? 64_000 : undefined);
    if (metadata === "unavailable") context.provider = undefined;
    const result = await contextCommand.execute("", context);
    expect(conversation.getContextWindow()).toBe(32_768);
    expect(lookup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "message", text: expect.stringMatching(/Total\s+32\.8k/) });
  });

  it("still resolves provider metadata when no manual answer exists", async () => {
    const { conversation, provider, context } = commandSetup();
    conversation.setManualContextWindow("other", 32_768);
    const lookup = vi.spyOn(provider, "getContextWindow").mockResolvedValue(64_000);
    await contextCommand.execute("", context);
    expect(lookup).toHaveBeenCalledWith(model);
    expect(conversation.getContextWindow()).toBe(64_000);
  });

  it("still rejects metadata from a stale model selection", async () => {
    const { conversation, provider, context } = commandSetup();
    let version = 0;
    context.getModelSelectionVersion = () => version;
    vi.spyOn(provider, "getContextWindow").mockImplementation(async () => {
      version++;
      context.config.model = "other";
      conversation.setModel("other");
      return 64_000;
    });
    await contextCommand.execute("", context);
    expect(conversation.getContextWindow()).toBeUndefined();
  });
});
