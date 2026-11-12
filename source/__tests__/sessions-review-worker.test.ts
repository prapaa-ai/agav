import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../config/config.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { ConversationState } from "../agent/conversation.js";
import { loadSession } from "../config/history.js";
import { SessionApprovalBroker } from "../sessions/approvals.js";
import { createSessionExecution, prepareSessionTools, sessionExecutionConfig, startSessionExecution, type SessionExecutionHandle } from "../sessions/runner.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { createToolRegistry } from "../tools/registry-factory.js";
import { ToolRegistry } from "../tools/registry.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile) };
});
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({
  loadSkills: async () => [],
  getSkill: () => ({ name: "fixture", slug: "fixture", description: "fixture", body: "Do the task",
    frontmatter: { name: "fixture", description: "fixture", invocation: "both" }, origin: "project", filePath: "/fixture/SKILL.md" }),
}));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [] }));

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 128,
  maxIterations: 6, errorRetries: 0, permissionMode: "auto-accept", systemPrompt: "fixture" };
let root: string;
let store: SessionRuntimeStore;
const handles: SessionExecutionHandle[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-session-review-"));
  vi.spyOn(configModule, "getAgavDir").mockReturnValue(root);
  store = new SessionRuntimeStore(root);
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function runtime(settings = config) {
  const conversation = new ConversationState();
  conversation.addUserMessage("Do the task");
  return createSessionExecution(store, settings, { conversation });
}
function toolTurn(name: string, input: Record<string, unknown>): StreamEvent[] {
  return [
    { type: "tool_call_start", toolCallId: "delegate", toolName: name },
    { type: "tool_call_delta", toolCallId: "delegate", argsJson: JSON.stringify(input) },
    { type: "tool_call_end", toolCallId: "delegate" },
    { type: "message_end", stopReason: "tool_calls" },
  ];
}

describe("reviewed worker delegation", () => {
  it.each(["subagent", "activate_skill"])("installs and executes %s in the production reserved registry", async name => {
    const record = await runtime();
    let calls = 0;
    const provider: LLMProvider = { name: "fixture", async *stream(): AsyncGenerator<StreamEvent> {
      if (calls++ === 0) yield* toolTurn(name, name === "subagent" ? { title: "Child", task: "Do the task" } : { name: "fixture" });
      else {
        yield { type: "text_delta", text: "child finished" };
        yield { type: "message_end", stopReason: "end_turn" };
      }
    } };
    // Do not inject an empty registry: it would miss production's reserved names.
    const handle = startSessionExecution(record.id, { store, config, provider });
    handles.push(handle);
    const result = await handle.done;
    expect(result.status, result.error).toBe("completed");
    expect(calls).toBe(3);
    expect(result.messages.flatMap(message => message.content)).toContainEqual(expect.objectContaining({
      type: "tool_result", isError: false, toolResult: expect.stringContaining("child finished"),
    }));
  });

  it("keeps delegated builtins protected against later untrusted registrations", async () => {
    const record = await runtime();
    const registry = createToolRegistry(config);
    const broker = new SessionApprovalBroker(store, record.id, record.generation);
    const cleanup = await prepareSessionTools({ registry, config, provider: { name: "fixture", async *stream() {} },
      broker, signal: new AbortController().signal, iterationsBudget: { remaining: 6, total: 6 },
      confirmTool: async () => "yes", backgroundPermissionMode: "ask" });
    try {
      for (const name of ["subagent", "activate_skill"]) {
        const builtin = registry.get(name);
        expect(builtin).toBeDefined();
        expect(registry.register({ schema: { name, description: "untrusted", inputSchema: {} },
          execute: async () => ({ output: "untrusted", isError: false }) })).toBe(false);
        expect(registry.get(name)).toBe(builtin);
      }
    } finally { broker.clear(); await cleanup(); }
  });

  it.each(["parent", "subagent", "activate_skill"])("forwards idle timeout to %s and checkpoints a stalled response", async path => {
    const settings = { ...config, providerIdleTimeout: 30 };
    const record = await runtime(settings);
    let calls = 0;
    let stalledSignal: AbortSignal | undefined;
    const provider: LLMProvider = { name: "fixture", async *stream(params): AsyncGenerator<StreamEvent> {
      const call = calls++;
      if (path !== "parent" && call === 0) {
        yield* toolTurn(path, path === "subagent" ? { title: "Child", task: "Do the task" } : { name: "fixture" });
      } else if (call === (path === "parent" ? 0 : 1)) {
        stalledSignal = params.signal;
        yield { type: "text_delta", text: "partial response" };
        await new Promise<void>(resolve => {
          if (params.signal?.aborted) resolve();
          else params.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } else {
        yield { type: "text_delta", text: "parent finished" };
        yield { type: "message_end", stopReason: "end_turn" };
      }
    } };
    const handle = startSessionExecution(record.id, { store, config: settings, provider,
      ...(path === "parent" ? { registry: new ToolRegistry() } : {}) });
    handles.push(handle);
    await vi.waitFor(async () => {
      expect(stalledSignal?.aborted).toBe(true);
      expect((await store.read(record.id))?.status).toBe(path === "parent" ? "failed" : "completed");
    }, { timeout: 1500, interval: 10 });
    const result = await handle.done;
    if (path === "parent") {
      expect(result.error).toContain("Provider response idle timeout after 30ms");
      expect(result.messages.at(-1)?.content).toEqual([{ type: "text", text: "partial response" }]);
      const events = await readFile(join(store.directory(record.id), "events.jsonl"), "utf8");
      expect(events).toContain('"reason":"provider_idle_timeout"');
    } else {
      expect(result.messages.flatMap(message => message.content)).toContainEqual(expect.objectContaining({
        type: "tool_result", toolResult: expect.stringContaining("Provider response idle timeout after 30ms"),
      }));
    }
    expect(result).toMatchObject({ streamingText: "", thinkingText: "", toolCalls: [], subagentStates: [] });
    expect(await loadSession(record.id)).toMatchObject({ messages: JSON.parse(JSON.stringify(result.messages)) });
  });
});

describe("Ollama credential routing", () => {
  it.each([
    { env: { OLLAMA_ENDPOINT: "https://env.example" }, stored: { ollamaEndpoint: "https://file.example" }, changed: true },
    { env: { OLLAMA_HOST: "env.example", OLLAMA_PORT: "12345" }, stored: { ollamaHost: "file.example", ollamaPort: 11434 }, changed: true },
    { env: { OLLAMA_HOST: "ignored.example", OLLAMA_PORT: "12345" }, stored: { ollamaEndpoint: "https://file.example" }, changed: false },
  ])("checks the trusted env-resolved route with endpoint precedence ($env)", async ({ env, stored, changed }) => {
    const record = await runtime({ ...config, provider: "ollama", ...stored });
    for (const name of ["OLLAMA_ENDPOINT", "OLLAMA_HOST", "OLLAMA_PORT"]) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    // Exercise real loadConfig env precedence without reading or modifying a real profile.
    vi.spyOn(fs, "readFile").mockImplementation(async path =>
      String(path).endsWith("/config.json") ? JSON.stringify({ ...config, provider: "ollama", ...stored }) : "{}");
    vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    const cwd = process.cwd();
    let local: AgavConfig;
    try { process.chdir(root); local = await configModule.loadConfig(); }
    finally { process.chdir(cwd); }
    if (changed) expect(() => sessionExecutionConfig(record, local)).toThrow(/endpoint|routing/i);
    else expect(sessionExecutionConfig(record, local).ollamaEndpoint).toBe("https://file.example");
  });
  it.each([
    [{ ollamaEndpoint: "https://old.example" }, { ollamaEndpoint: "https://current.example" }],
    [{ ollamaHost: "old.example", ollamaPort: 11434 }, { ollamaHost: "current.example", ollamaPort: 11434 }],
    [{ ollamaHost: "same.example", ollamaPort: 11434 }, { ollamaHost: "same.example", ollamaPort: 12345 }],
    [{ ollamaEndpoint: "https://old.example" }, {}],
    [{}, { ollamaEndpoint: "https://current.example" }],
  ])("rejects a changed effective route before reusing current credentials (%j -> %j)", async (stored, current) => {
    const record = await runtime({ ...config, provider: "ollama", ...stored });
    expect(() => sessionExecutionConfig(record, { ...config, provider: "ollama", ...current, ollamaApiKey: "fresh-key" })).toThrow(/endpoint|routing/i);
  });

  it.each([
    [{ ollamaEndpoint: "https://same.example", ollamaHost: "old", ollamaPort: 1 }, { ollamaEndpoint: "https://same.example", ollamaHost: "new", ollamaPort: 2 }],
    [{ ollamaHost: "localhost", ollamaPort: 11434 }, {}],
    [{ ollamaEndpoint: "http://localhost:11434" }, { ollamaHost: "localhost", ollamaPort: 11434 }],
  ])("accepts equivalent effective routes despite overridden fields (%j -> %j)", async (stored, current) => {
    const record = await runtime({ ...config, provider: "ollama", ...stored });
    expect(sessionExecutionConfig(record, { ...config, provider: "ollama", ...current, ollamaApiKey: "fresh-key" }).ollamaApiKey).toBe("fresh-key");
  });
});
