import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  StreamParams,
  StreamEvent,
  Message,
  ContentBlock,
  ToolSchema,
} from "./types.js";
import { applyEffortPrompt, supportsNativeEffort } from "./effort.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  // Translate Anthropic's streaming event model into the provider-agnostic event stream used by the app.
  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const nativeEffort = params.effort && supportsNativeEffort(this.name, params.model)
      ? params.effort
      : undefined;
    const systemPrompt = nativeEffort
      ? params.systemPrompt
      : applyEffortPrompt(params.systemPrompt, params.effort ?? "medium");
    const systemBlocks = systemPrompt
      ? [{ type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } }]
      : undefined;

    const tools = params.tools?.map((t, i, arr) => {
      const tool = this.toTool(t);
      // Cache the last tool definition — covers the whole tool list
      if (i === arr.length - 1) {
        return { ...tool, cache_control: { type: "ephemeral" as const } };
      }
      return tool;
    });

    const stream = this.client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens ?? 16384,
      system: systemBlocks as any,
      messages: this.toMessages(params.messages),
      tools: tools as any,
      output_config: nativeEffort ? { effort: nativeEffort } : undefined,
    });

    // Track which content block index maps to which tool call ID
    const blockToolIds = new Map<number, string>();
    let currentBlockIndex = -1;

    yield { type: "message_start" };

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        currentBlockIndex = event.index;
        if (event.content_block.type === "tool_use") {
          blockToolIds.set(event.index, event.content_block.id);
          yield {
            type: "tool_call_start",
            toolCallId: event.content_block.id,
            toolName: event.content_block.name,
          };
        }
      } else if (event.type === "content_block_delta") {
        if ((event.delta as any).type === "thinking_delta") {
          yield { type: "thinking_delta", text: (event.delta as any).thinking };
        } else if (event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          const toolId = blockToolIds.get(event.index);
          if (toolId) {
            yield {
              type: "tool_call_delta",
              toolCallId: toolId,
              argsJson: event.delta.partial_json,
            };
          }
        }
      } else if (event.type === "content_block_stop") {
        const toolId = blockToolIds.get(event.index);
        if (toolId) {
          yield { type: "tool_call_end", toolCallId: toolId };
        }
      } else if (event.type === "message_start") {
        if (event.message?.usage) {
          const u = event.message.usage as any;
          yield {
            type: "usage",
            inputTokens: u.input_tokens ?? 0,
            outputTokens: 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          };
        }
      } else if (event.type === "message_delta") {
        const outputTokens = (event as any).usage?.output_tokens ?? 0;
        if (outputTokens > 0) {
          yield { type: "usage", inputTokens: 0, outputTokens };
        }
        yield {
          type: "message_end",
          stopReason: event.delta.stop_reason ?? "end_turn",
        };
      }
    }
  }

  // Anthropic accepts structured content blocks directly, so this is mostly a shape conversion.
  private toMessages(
    messages: Message[],
  ): Anthropic.Messages.MessageParam[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content.map((block) => this.toContentBlock(block)),
    }));
  }

  private toContentBlock(
    block: ContentBlock,
  ): Anthropic.Messages.ContentBlockParam {
    if (block.type === "text") {
      return { type: "text", text: block.text! };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.toolCallId!,
        name: block.toolName!,
        input: block.toolInput!,
      };
    }
    if (block.type === "tool_result") {
      const nested = block.toolResultContent
        ?.filter((item) => item.type === "text" || item.type === "image")
        .map((item) => {
          if (item.type === "image" && item.imageData) {
            return {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: item.imageMediaType ?? "image/jpeg",
                data: item.imageData,
              },
            };
          }
          return { type: "text" as const, text: item.text ?? "" };
        });
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId!,
        content: (nested && nested.length > 0 ? nested : block.toolResult!) as Anthropic.Messages.ToolResultBlockParam["content"],
        is_error: block.isError,
      };
    }
    if (block.type === "image" && block.imageData) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.imageMediaType ?? "image/png",
          data: block.imageData,
        },
      } as any;
    }
    return { type: "text", text: block.text ?? "" };
  }

  private toTool(schema: ToolSchema): Anthropic.Messages.Tool {
    return {
      name: schema.name,
      description: schema.description,
      input_schema: schema.inputSchema as Anthropic.Messages.Tool.InputSchema,
    };
  }
}
