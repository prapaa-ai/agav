import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs, runPipeMode } from "../main.js";
import { loadConfig, type AgavConfig } from "../config/config.js";
import { createProvider } from "../providers/registry.js";
import { render } from "../ink/index.js";
import type { Message, LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { AgavRunUsage } from "../utils/trajectory.js";
import { NO_EDITS_PROMPT, SCHEMA_RETRY_PREFIX } from "../agent/internal-prompts.js";

vi.mock("../config/config.js", async (original) => ({ ...await original<typeof import("../config/config.js")>(), loadConfig: vi.fn() }));
vi.mock("../config/keybindings.js", () => ({ loadKeybindings: async () => ({}) }));
vi.mock("../config/history.js", () => ({ listSessions: async () => [] }));
vi.mock("../providers/registry.js", () => ({ createProvider: vi.fn() }));
vi.mock("../ink/index.js", () => ({ render: vi.fn(() => ({ waitUntilExit: async () => {} })) }));
vi.mock("../utils/auto-update.js", () => ({ checkAndUpdate: async () => {} }));
vi.mock("../utils/git.js", () => ({ getGitContext: async () => null }));
vi.mock("../utils/terminal-keyboard.js", () => ({ detectKittyKeyboard: async () => false }));
vi.mock("../utils/system-prompt.js", () => ({ refreshDynamicContext: async () => "" }));
vi.mock("../utils/temp-output.js", () => ({ tempOutputManager: { pruneStale: vi.fn() } }));
vi.mock("../tools/registry-factory.js", async (original) => {
  const actual = await original<typeof import("../tools/registry-factory.js")>();
  const { ToolRegistry } = await import("../tools/registry.js");
  return { ...actual, createToolRegistry: () => {
    const registry = new ToolRegistry();
    registry.register({
      schema: { name: "read_file", description: "Read a trajectory fixture", inputSchema: { type: "object" } },
      execute: async () => ({ output: "trajectory fixture contents", isError: false }),
    });
    return registry;
  } };
});

const config: AgavConfig = {
  provider: "ollama", model: "trajectory-test-model", systemPrompt: "test", effort: "low",
  maxTokens: 1024, maxIterations: 8, errorRetries: 0, permissionMode: "auto-accept",
};
const zeroUsage: AgavRunUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const text = (value: string): StreamEvent[] => [
  { type: "text_delta", text: value }, { type: "message_end", stopReason: "end_turn" },
];
const read: StreamEvent[] = [
  { type: "text_delta", text: "Inspecting the fixture." },
  { type: "tool_call_start", toolCallId: "trajectory-read-1", toolName: "read_file" },
  { type: "tool_call_delta", toolCallId: "trajectory-read-1", argsJson: '{"path":"fixture.txt"}' },
  { type: "tool_call_end", toolCallId: "trajectory-read-1" },
  { type: "message_end", stopReason: "tool_calls" },
];
function providerFor(responses: Array<StreamEvent[] | Error>) {
  const stream = vi.fn((_params: StreamParams) => (async function* (): AsyncGenerator<StreamEvent> {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected extra trajectory model request");
    for (const event of response) yield event;
  })());
  return { name: "mock", stream } satisfies LLMProvider;
}

// The intersection lets these regression tests typecheck before the new option lands.
type TrajectoryOptions = NonNullable<Parameters<typeof runPipeMode>[3]> & { trajectoryPath: string };
interface Trajectory {
  agav_trajectory_version: number;
  model: string;
  provider: string;
  started_at: string;
  finished_at: string;
  usage: AgavRunUsage;
  messages: Message[];
}
const stdout = () => vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
const stderr = () => vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("");
const originalArgv = process.argv;
const exited = new Error("trajectory test process exited");
let directory: string;
let trajectoryPath: string;
let provider: ReturnType<typeof providerFor>;

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "agav-cli-trajectory-"));
  trajectoryPath = join(directory, "run=trajectory.json");
  provider = providerFor([text("done")]);
  vi.mocked(loadConfig).mockResolvedValue({ ...config });
  vi.mocked(createProvider).mockReturnValue(provider);
  vi.spyOn(process, "exit").mockImplementation(() => { throw exited; });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as typeof process.stdin);
  vi.spyOn(process, "on").mockImplementation(() => process);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network is forbidden in trajectory tests"); });
});
afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function invoke(args: string[]) {
  process.argv = [process.execPath, "agav", "--provider", "ollama", ...args];
  await expect(main()).rejects.toBe(exited);
}
async function exported(): Promise<Trajectory> {
  const result = JSON.parse(await readFile(trajectoryPath, "utf-8")) as Trajectory;
  expect(result.agav_trajectory_version).toBe(1);
  expect(result.model).toBe(config.model);
  expect(result.provider).toBe(config.provider);
  expect(new Date(result.started_at).toISOString()).toBe(result.started_at);
  expect(new Date(result.finished_at).toISOString()).toBe(result.finished_at);
  expect(Date.parse(result.finished_at)).toBeGreaterThanOrEqual(Date.parse(result.started_at));
  expect(result.messages[0]).toMatchObject({ role: "user" });
  return result;
}
function options(extra: Partial<TrajectoryOptions> = {}): TrajectoryOptions {
  return { stdinContent: "", trajectoryPath, ...extra };
}
const messageText = (message: Message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("");

function expectToolCycle(result: Trajectory) {
  const blocks = result.messages.flatMap((message) => message.content);
  expect(blocks).toContainEqual({ type: "tool_use", toolCallId: "trajectory-read-1", toolName: "read_file", toolInput: { path: "fixture.txt" } });
  expect(blocks).toContainEqual(expect.objectContaining({ type: "tool_result", toolCallId: "trajectory-read-1", toolResult: "trajectory fixture contents", isError: false }));
  expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
}

describe("--trajectory CLI", () => {
  it.each(["-P", "--print", "run"])("parses and forwards both path forms through %s main", async (mode) => {
    for (const flag of [["--trajectory", trajectoryPath], [`--trajectory=${trajectoryPath}`]]) {
      const args = [mode, "Inspect the fixture", ...flag];
      const parsed = parseArgs(args);
      // Assert the path survives parsing without prescribing the internal flags key.
      expect(Object.values(parsed)).toContain(trajectoryPath);
      expect(parsed[mode === "run" ? "runPrompt" : "printPrompt"]).toBe("Inspect the fixture");
      provider.stream.mockImplementation(() => (async function* () { yield* text("done"); })());
      await invoke(args);
      expect(process.exit).toHaveBeenLastCalledWith(0);
      expect((await exported()).messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "done" }] });
      expect(render).not.toHaveBeenCalled();
      // Remove the first export so the second form cannot pass using a stale file.
      await rm(trajectoryPath);
    }
    expect(provider.stream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["run", "Inspect", "--trajectory"],
    ["-P", "Inspect", "--trajectory", ""],
    ["run", "Inspect", "--trajectory="],
    ["run", "Inspect", "--trajectory", "--stream"],
  ])("rejects a missing/empty path before startup: %j", async (...args) => {
    await invoke(args);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderr()).toMatch(/--trajectory.*(?:path|argument|non.?empty)/i);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("rejects trajectory export for an interactive session", async () => {
    await invoke(["--trajectory", trajectoryPath]);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderr()).toMatch(/--trajectory/);
    expect(stderr()).toMatch(/(?:run|print|-P|non-interactive)/i);
    expect(createProvider).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(provider.stream).not.toHaveBeenCalled();
  });
});

describe("real pipe-mode trajectory export", () => {
  it("leaves pipe mode unchanged and writes no file when export is omitted", async () => {
    expect(await runPipeMode("Inspect the fixture", config, provider, { stdinContent: "" })).toBe(0);
    expect(stdout()).toBe("done\n");
    expect(stderr()).toBe("");
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("exports an ordered tool cycle and sums split usage events including cache writes", async () => {
    provider = providerFor([
      [
        ...read,
        { type: "usage", inputTokens: 11, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 5 },
        { type: "usage", inputTokens: 0, outputTokens: 7 },
      ],
      [...text("Fixture inspected."), { type: "usage", inputTokens: 13, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6 }],
    ]);
    expect(await runPipeMode("Inspect the fixture", config, provider, options())).toBe(0);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(stdout()).toBe("Fixture inspected.\n");
    const result = await exported();
    expectToolCycle(result);
    expect(messageText(result.messages[0]!)).toBe("Inspect the fixture");
    expect(messageText(result.messages.at(-1)!)).toBe("Fixture inspected.");
    expect(result.usage).toEqual({ input_tokens: 24, output_tokens: 9, cache_read_tokens: 7, cache_write_tokens: 11 });
  });

  it.each(["emitted", "thrown"])("exports completed history and usage after a %s provider failure", async (failure) => {
    const error = new Error(`trajectory ${failure} provider failure`);
    provider = providerFor([
      [...read, { type: "usage", inputTokens: 9, outputTokens: 2, cacheWriteTokens: 4 }],
      failure === "emitted"
        ? [{ type: "usage", inputTokens: 3, outputTokens: 1, cacheReadTokens: 2 }, { type: "error", error }]
        : error,
    ]);
    expect(await runPipeMode("Inspect the fixture", config, provider, options())).toBe(1);
    expect(stderr()).toContain(error.message);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    const result = await exported();
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(result.messages.at(-1)!.content).toContainEqual(expect.objectContaining({ type: "tool_result", toolCallId: "trajectory-read-1", toolResult: "trajectory fixture contents" }));
    expect(result.usage).toEqual({ input_tokens: failure === "emitted" ? 12 : 9, output_tokens: failure === "emitted" ? 3 : 2, cache_read_tokens: failure === "emitted" ? 2 : 0, cache_write_tokens: 4 });
  });

  it("retains all no-edit retry messages and usage rather than only the last attempt", async () => {
    provider = providerFor(Array.from({ length: 4 }, (_, index) => [
      ...text(`Analysis ${index + 1}`),
      { type: "usage" as const, inputTokens: index + 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    ]));
    expect(await runPipeMode("Fix the fixture", config, provider, options())).toBe(0);
    expect(provider.stream).toHaveBeenCalledTimes(4);
    const result = await exported();
    expect(result.messages.filter((message) => message.role === "assistant").map(messageText)).toEqual(["Analysis 1", "Analysis 2", "Analysis 3", "Analysis 4"]);
    expect(result.messages.filter((message) => messageText(message) === NO_EDITS_PROMPT)).toHaveLength(3);
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 8, cache_read_tokens: 12, cache_write_tokens: 16 });
  });

  it.each([true, false])("exports schema retry history and usage when correction succeeds=%s", async (success) => {
    const correction = success ? '{"ok":true}' : '{"ok":null}';
    provider = providerFor([
      [...text('{"ok":"wrong"}'), { type: "usage", inputTokens: 5, outputTokens: 3, cacheWriteTokens: 7 }],
      [...text(correction), { type: "usage", inputTokens: 11, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 1 }],
    ]);
    expect(await runPipeMode("Return a result", config, provider, options({ outputSchema: schema, stream: true }))).toBe(success ? 0 : 1);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(stdout()).toBe(success ? '{"ok":true}\n' : "");
    expect(stderr()).toContain("retrying once");
    const result = await exported();
    expect(result.messages.filter((message) => message.role === "assistant").map(messageText)).toEqual(['{"ok":"wrong"}', correction]);
    expect(result.messages.some((message) => messageText(message).startsWith(SCHEMA_RETRY_PREFIX))).toBe(true);
    expect(result.usage).toEqual({ input_tokens: 16, output_tokens: 5, cache_read_tokens: 7, cache_write_tokens: 8 });
  });

  it("exports schema failure when there is no remaining retry allowance", async () => {
    provider = providerFor([text("not JSON")]);
    expect(await runPipeMode("Return a result", { ...config, maxIterations: 1 }, provider, options({ outputSchema: schema }))).toBe(1);
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(stderr()).toMatch(/JSON Schema validation.*maximum iterations/);
    expect((await exported()).usage).toEqual(zeroUsage);
  });

  it("returns 1 and reports a real filesystem export failure on stderr", async () => {
    expect(await runPipeMode("Inspect the fixture", config, provider, options({ trajectoryPath: directory }))).toBe(1);
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(stderr()).toMatch(/trajectory/i);
    expect(stderr()).toMatch(/(?:EISDIR|directory|illegal operation)/i);
  });
});
