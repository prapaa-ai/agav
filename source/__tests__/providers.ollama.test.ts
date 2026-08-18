import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../providers/types.js";

const chat = vi.fn();
const show = vi.fn();

vi.mock("ollama", () => ({
  Ollama: class {
    chat = chat;
    show = show;
  },
}));

const { OllamaProvider } = await import("../providers/ollama.js");

/** Replay pre-baked chat chunks as the async iterable the SDK returns. */
function replay(chunks: unknown[]): void {
  chat.mockImplementation(async () => (async function* () {
    for (const chunk of chunks) yield chunk;
  })());
}

const done = { done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 };

async function collect(model = "llama3.2:1b"): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of new OllamaProvider("http://localhost:11434").stream({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    systemPrompt: "sys",
  })) {
    events.push(event);
  }
  return events;
}

const startsOf = (events: StreamEvent[]) => events.filter((e) => e.type === "tool_call_start");

beforeEach(() => {
  vi.clearAllMocks();
  show.mockResolvedValue({ model_info: { "llama.context_length": 131_072 } });
});

describe("OllamaProvider tool-call identity", () => {
  // Ollama's ToolCall type has no id, so servers that omit it used to fall back
  // to a name+Date.now() id. Two parallel calls to the same tool land in the
  // same millisecond, collide, and every call but the first was dropped.
  it("emits both parallel calls to the same tool when the server sends no id", async () => {
    replay([
      {
        message: {
          tool_calls: [
            { function: { name: "read_file", arguments: { path: "a.txt" } } },
            { function: { name: "read_file", arguments: { path: "b.txt" } } },
          ],
        },
      },
      done,
    ]);

    const starts = startsOf(await collect());
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((s) => s.toolCallId)).size).toBe(2);
  });

  it("collapses the same call repeated across chunks", async () => {
    const call = { function: { name: "read_file", index: 0, arguments: { path: "a.txt" } } };
    replay([{ message: { tool_calls: [call] } }, { message: { tool_calls: [call] } }, done]);

    expect(startsOf(await collect())).toHaveLength(1);
  });

  it("keeps distinct calls apart by index even with identical arguments", async () => {
    replay([
      {
        message: {
          tool_calls: [
            { function: { name: "run_command", index: 0, arguments: { cmd: "ls" } } },
            { function: { name: "run_command", index: 1, arguments: { cmd: "ls" } } },
          ],
        },
      },
      done,
    ]);

    expect(startsOf(await collect())).toHaveLength(2);
  });

  it("uses the server-provided id when present", async () => {
    replay([
      { message: { tool_calls: [{ id: "call_abc", function: { name: "read_file", arguments: {} } }] } },
      done,
    ]);

    expect(startsOf(await collect())[0]?.toolCallId).toBe("call_abc");
  });
});

describe("OllamaProvider context window", () => {
  it("clamps the trained length to the cap", async () => {
    const provider = new OllamaProvider("http://localhost:11434");
    expect(await provider.getContextWindow("llama3.2:1b")).toBe(32_768);
  });

  it("uses the trained length when it is below the cap", async () => {
    show.mockResolvedValue({ model_info: { "llama.context_length": 8_192 } });
    const provider = new OllamaProvider("http://localhost:11434");
    expect(await provider.getContextWindow("llama2")).toBe(8_192);
  });

  it("reads any arch-prefixed context_length key", async () => {
    show.mockResolvedValue({ model_info: { "gemma4.context_length": 4_096 } });
    const provider = new OllamaProvider("http://localhost:11434");
    expect(await provider.getContextWindow("gemma4:e2b")).toBe(4_096);
  });

  it("falls back to the cap when /api/show fails", async () => {
    show.mockRejectedValue(new Error("404"));
    const provider = new OllamaProvider("http://localhost:11434");
    expect(await provider.getContextWindow("mystery")).toBe(32_768);
  });

  it("probes /api/show once per model", async () => {
    const provider = new OllamaProvider("http://localhost:11434");
    await provider.getContextWindow("llama3.2:1b");
    await provider.getContextWindow("llama3.2:1b");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved window to the chat request as num_ctx", async () => {
    replay([done]);
    await collect();
    expect(chat.mock.calls[0]?.[0].options.num_ctx).toBe(32_768);
  });
});
