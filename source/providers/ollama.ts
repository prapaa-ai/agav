import { Ollama } from "ollama";
import type { Message as OllamaMessage, Tool as OllamaTool } from "ollama";
import type {
  LLMProvider,
  StreamParams,
  StreamEvent,
  Message,
  ToolSchema,
} from "./types.js";
import { applyOllamaEffortPrompt } from "./effort.js";

// Ollama defaults to a 4096-token context and silently truncates anything longer.
// Agav's system prompt plus tool schemas already exceeds that, so the model would
// lose its instructions — and often the user's own message — without any error.
const CONTEXT_CAP = 32768;

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private client: Ollama;
  /** Resolved context size per model, so /api/show is only hit once each. */
  private contextSizes = new Map<string, number>();

  constructor(host: string, apiKey?: string) {
    this.client = new Ollama({
      host,
      ...(apiKey
        ? { headers: { Authorization: `Bearer ${apiKey}` } }
        : {}),
    });
  }

  /**
   * Report the window actually sent as num_ctx, so conversation compaction
   * targets the real limit instead of the generic name-based fallback.
   */
  async getContextWindow(model: string): Promise<number | undefined> {
    return this.resolveContextSize(model);
  }

  // Use as much context as the model was trained for, bounded so a large model
  // does not allocate a KV cache the machine cannot hold.
  private async resolveContextSize(model: string): Promise<number> {
    const cached = this.contextSizes.get(model);
    if (cached) return cached;

    const cap = Number(process.env["AGAV_OLLAMA_NUM_CTX"]) || CONTEXT_CAP;
    let trained = cap;

    try {
      const info = await this.client.show({ model });
      // model_info is a plain object at runtime and keys are arch-prefixed,
      // e.g. "gemma3.context_length" / "llama.context_length".
      const entries = Object.entries(
        (info.model_info ?? {}) as unknown as Record<string, unknown>,
      );
      const match = entries.find(([key]) => key.endsWith(".context_length"));
      if (typeof match?.[1] === "number" && match[1] > 0) {
        trained = match[1];
      }
    } catch {
      // Older servers or restricted endpoints — fall back to the cap.
    }

    const size = Math.min(trained, cap);
    this.contextSizes.set(model, size);
    return size;
  }

  // Adapt Ollama's chat stream to the shared event format while smoothing over model-specific tool-call quirks.
  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const messages = this.toMessages(
      params.messages,
      applyOllamaEffortPrompt(params.systemPrompt, params.effort ?? "medium"),
    );
    const tools = params.tools?.length ? params.tools.map(this.toTool) : undefined;

    try {
      const response = await this.client.chat({
        model: params.model,
        messages,
        tools,
        stream: true,
        options: {
          num_predict: params.maxTokens ?? 16384,
          num_ctx: await this.resolveContextSize(params.model),
        },
      });

      yield { type: "message_start" };

      // Ollama repeats a tool_call across chunks, so each one needs a stable
      // identity. Keyed by that identity to the ID we handed out, so repeats
      // collapse and genuinely distinct calls stay distinct.
      const emittedToolCalls = new Map<string, string>();
      let toolCallSeq = 0;

      for await (const part of response) {
        const msg = part.message;
        if (!msg) continue;

        if (msg.thinking) {
          yield { type: "thinking_delta", text: msg.thinking };
        }

        if (msg.content) {
          yield { type: "text_delta", text: msg.content };
        }

        // Tool calls arrive in non-done chunks — do not gate on part.done.
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            // Some models return arguments as a JSON string; normalise either way.
            const argsJson =
              typeof tc.function.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments);

            // Neither `id` nor `function.index` is in the ollama package's
            // ToolCall type, but servers do send them, so prefer them and keep
            // the casts. The last resort keys on name+arguments: timestamps
            // used to collide for parallel calls to the same tool within a
            // millisecond, which silently dropped every call but the first.
            const rawId = (tc as { id?: string }).id;
            const rawIndex = (tc.function as { index?: number }).index;
            const key = rawId
              ?? (typeof rawIndex === "number"
                ? `${tc.function.name}#${rawIndex}`
                : `${tc.function.name}:${argsJson}`);
            if (emittedToolCalls.has(key)) continue;

            const id = rawId ?? `call_${tc.function.name}_${toolCallSeq++}`;
            emittedToolCalls.set(key, id);

            yield { type: "tool_call_start", toolCallId: id, toolName: tc.function.name };
            yield { type: "tool_call_delta", toolCallId: id, argsJson };
            yield { type: "tool_call_end", toolCallId: id };
          }
        }

        if (part.done) {
          yield {
            type: "usage",
            inputTokens: part.prompt_eval_count ?? 0,
            outputTokens: part.eval_count ?? 0,
          };

          yield {
            type: "message_end",
            stopReason: part.done_reason ?? "stop",
          };
        }
      }
    }
    catch (e: unknown) {
      // Swallowing this used to end the turn with no output and no explanation.
      // Rethrow so the agent loop can surface it (and attempt context recovery).
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`Ollama request failed (${params.model}): ${detail}`, { cause: e });
    }
  }

  // Rebuild tool-result messages with tool_name metadata because Ollama links results by name, not call ID.
  private toMessages(messages: Message[], systemPrompt?: string): OllamaMessage[] {
    const result: OllamaMessage[] = [];
    // Built incrementally as we encounter assistant tool_use blocks so that
    // subsequent tool-result messages can resolve their tool_name.
    const idToName = new Map<string, string>();

    if (systemPrompt) {
      result.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === "user") {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          const previewImages: string[] = [];
          for (const block of toolResults) {
            const toolName = block.toolCallId ? idToName.get(block.toolCallId) : undefined;
            result.push({
              role: "tool",
              content: block.toolResult ?? "",
              ...(toolName ? { tool_name: toolName } : {}),
            });
            previewImages.push(...(block.toolResultContent ?? [])
              .filter((item) => item.type === "image" && item.imageData)
              .map((item) => item.imageData!));
          }
          if (previewImages.length > 0) {
            result.push({ role: "user", content: "Visual previews returned by the preceding tool results.", images: previewImages });
          }
        } else {
          const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          const images = msg.content.filter((b) => b.type === "image" && b.imageData).map((b) => b.imageData!);
          result.push({ role: "user", content: text, ...(images.length > 0 ? { images } : {}) });
        }
      } else if (msg.role === "assistant") {
        const text = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolCalls = msg.content
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            if (b.toolCallId && b.toolName) {
              idToName.set(b.toolCallId, b.toolName);
            }
            return {
              function: {
                name: b.toolName!,
                // Ollama expects arguments as an object, not a JSON string
                arguments: b.toolInput ?? {},
              },
            };
          });

        result.push({
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    }

    return result;
  }

  private toTool(schema: ToolSchema): OllamaTool {
    return {
      type: "function",
      function: {
        name: schema.name,
        description: schema.description,
        parameters: schema.inputSchema as OllamaTool["function"]["parameters"],
      },
    };
  }
}
