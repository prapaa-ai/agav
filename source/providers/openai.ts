import OpenAI from "openai";
import type {
  LLMProvider,
  StreamParams,
  StreamEvent,
  Message,
  ContentBlock,
  ToolSchema,
} from "./types.js";
import {
  applyEffortPrompt,
  mapOpenAIEffort,
  supportsNativeEffort,
  supportsOpenAIChatToolEffort,
} from "./effort.js";

type ResponseInput = OpenAI.Responses.ResponseInput;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;
type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;

export type OpenAIApiMode = "responses" | "chat";

export interface OpenAIProviderOptions {
  name?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;
  private apiMode: OpenAIApiMode;
  private toolEffortUnsupportedModels = new Set<string>();

  constructor(apiKey: string, apiMode: OpenAIApiMode = "responses", options: OpenAIProviderOptions = {}) {
    this.name = options.name ?? "openai";
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
    });
    this.apiMode = apiMode;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    if (this.apiMode === "responses") {
      yield* this.streamResponses(params);
    } else {
      yield* this.streamChat(params);
    }
  }

  private async *streamResponses(params: StreamParams): AsyncIterable<StreamEvent> {
    const useNativeEffort = params.effort && supportsNativeEffort("openai", params.model);
    const systemPrompt = useNativeEffort
      ? params.systemPrompt
      : applyEffortPrompt(params.systemPrompt, params.effort ?? "medium");

    const tools: FunctionTool[] | undefined = params.tools?.length
      ? params.tools.map((t) => this.toResponsesTool(t))
      : undefined;

    const input = this.toResponsesInput(params.messages);

    const response = await this.client.responses.create({
      model: params.model,
      instructions: systemPrompt || undefined,
      input,
      tools,
      max_output_tokens: params.maxTokens ?? 16384,
      stream: true,
      ...(useNativeEffort ? { reasoning: { effort: mapOpenAIEffort(params.effort!), summary: "concise" } } : {}),
    });

    yield { type: "message_start" };

    // The Responses API uses two different IDs: item.call_id (the function call ID)
    // and item_id (the output item ID). Deltas reference item_id, but our agent loop
    // matches on the call_id from tool_call_start. Track the mapping.
    const itemToCallId = new Map<string, string>();

    for await (const event of response as AsyncIterable<ResponseStreamEvent>) {
      switch (event.type) {
        case "response.output_text.delta":
          yield { type: "text_delta", text: event.delta };
          break;

        case "response.reasoning_summary_text.delta":
          yield { type: "thinking_delta", text: event.delta };
          break;

        case "response.output_item.added":
          if (event.item.type === "function_call") {
            const callId = event.item.call_id || `call_${event.output_index}`;
            if (event.item.id) itemToCallId.set(event.item.id, callId);
            yield {
              type: "tool_call_start",
              toolCallId: callId,
              toolName: event.item.name,
            };
          }
          break;

        case "response.function_call_arguments.delta":
          yield {
            type: "tool_call_delta",
            toolCallId: itemToCallId.get(event.item_id) ?? event.item_id,
            argsJson: event.delta,
          };
          break;

        case "response.output_item.done":
          if (event.item.type === "function_call") {
            const callId = event.item.call_id || `call_${event.output_index}`;
            yield {
              type: "tool_call_end",
              toolCallId: callId,
            };
          }
          break;

        case "response.completed":
          if (event.response.usage) {
            yield {
              type: "usage",
              inputTokens: event.response.usage.input_tokens ?? 0,
              outputTokens: event.response.usage.output_tokens ?? 0,
              cacheReadTokens: (event.response.usage as any).input_tokens_details?.cached_tokens ?? 0,
            };
          }
          yield { type: "message_end", stopReason: event.response.status ?? "completed" };
          break;

        case "response.failed":
          yield {
            type: "error",
            error: new Error((event.response as any).status_details?.error?.message ?? "Response failed"),
          };
          break;
      }
    }
  }

  // Subclasses whose APIs predate max_completion_tokens can override this.
  protected getMaxTokensParam(maxTokens?: number): Record<string, number> {
    return { max_completion_tokens: maxTokens ?? 16384 };
  }

  private async *streamChat(params: StreamParams): AsyncIterable<StreamEvent> {
    const hasFunctionTools = Boolean(params.tools?.length);
    const normalizedModel = params.model.toLowerCase();
    let nativeEffort = params.effort
      && supportsNativeEffort(this.name, params.model)
      && (!hasFunctionTools || (
        supportsOpenAIChatToolEffort(params.model)
        && !this.toolEffortUnsupportedModels.has(normalizedModel)
      ))
      ? mapOpenAIEffort(params.effort)
      : undefined;
    let systemPrompt = nativeEffort
      ? params.systemPrompt
      : applyEffortPrompt(params.systemPrompt, params.effort ?? "medium");

    const createStream = (effort: typeof nativeEffort, prompt: string | undefined) =>
      this.client.chat.completions.create({
        model: params.model,
        ...this.getMaxTokensParam(params.maxTokens),
        messages: this.toChatMessages(params.messages, prompt),
        ...(effort ? { reasoning_effort: effort } : {}),
        tools: params.tools?.length ? params.tools.map((t) => this.toChatTool(t)) : undefined,
        stream: true,
        stream_options: { include_usage: true },
      });

    let stream;
    try {
      stream = await createStream(nativeEffort, systemPrompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unsupportedCombination = nativeEffort
        && hasFunctionTools
        && /function tools with reasoning_effort are not supported/i.test(message);
      if (!unsupportedCombination) throw error;

      this.toolEffortUnsupportedModels.add(normalizedModel);
      nativeEffort = undefined;
      systemPrompt = applyEffortPrompt(params.systemPrompt, params.effort ?? "medium");
      stream = await createStream(undefined, systemPrompt);
    }

    const activeCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    yield { type: "message_start" };

    for await (const chunk of stream) {
      if ((chunk as any).usage) {
        const u = (chunk as any).usage;
        yield {
          type: "usage",
          inputTokens: u.prompt_tokens ?? 0,
          outputTokens: u.completion_tokens ?? 0,
          cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      if (delta?.content) {
        yield { type: "text_delta", text: delta.content };
      }

      const reasoning = (delta as any)?.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        yield { type: "thinking_delta", text: reasoning };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            const id = tc.id ?? `call_${tc.index}`;
            activeCalls.set(tc.index, { id, name: tc.function.name, args: "" });
            yield {
              type: "tool_call_start",
              toolCallId: id,
              toolName: tc.function.name,
            };
          }
          if (tc.function?.arguments) {
            const call = activeCalls.get(tc.index);
            if (call) {
              call.args += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                toolCallId: call.id,
                argsJson: tc.function.arguments,
              };
            }
          }
        }
      }

      if (choice.finish_reason) {
        for (const [, call] of activeCalls) {
          yield { type: "tool_call_end", toolCallId: call.id };
        }
        yield {
          type: "message_end",
          stopReason: choice.finish_reason,
        };
      }
    }
  }

  // --- Responses API helpers ---

  private toResponsesInput(messages: Message[]): ResponseInput {
    const items: ResponseInputItem[] = [];
    let msgIndex = 0;

    for (const msg of messages) {
      if (msg.role === "user") {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          for (const block of toolResults) {
            items.push({
              type: "function_call_output",
              call_id: block.toolCallId!,
              output: block.toolResult ?? "",
            });
          }
        } else {
          const parts: any[] = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              parts.push({ type: "input_text", text: block.text });
            } else if (block.type === "image" && block.imageData) {
              parts.push({
                type: "input_image",
                image_url: `data:${block.imageMediaType ?? "image/png"};base64,${block.imageData}`,
              });
            }
          }
          if (parts.length > 0) {
            items.push({ type: "message", role: "user", content: parts });
          }
        }
      } else if (msg.role === "assistant") {
        const textBlocks = msg.content.filter((b) => b.type === "text" && b.text);
        const toolUses = msg.content.filter((b) => b.type === "tool_use");

        if (textBlocks.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            id: `msg_${msgIndex++}`,
            status: "completed",
            content: textBlocks.map((b) => ({ type: "output_text" as const, text: b.text!, annotations: [] })),
          } as any);
        }

        for (const block of toolUses) {
          items.push({
            type: "function_call",
            call_id: block.toolCallId!,
            name: block.toolName!,
            arguments: JSON.stringify(block.toolInput ?? {}),
            id: `fc_${msgIndex++}`,
            status: "completed",
          } as any);
        }
      }
    }

    return items;
  }

  private toResponsesTool(schema: ToolSchema): FunctionTool {
    return {
      type: "function",
      name: schema.name,
      description: schema.description,
      parameters: schema.inputSchema as any,
      strict: false,
    };
  }

  // --- Chat Completions helpers ---

  private toChatMessages(
    messages: Message[],
    systemPrompt?: string,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      result.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === "user") {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          const previewImages: ContentBlock[] = [];
          for (const block of toolResults) {
            result.push({
              role: "tool" as const,
              tool_call_id: block.toolCallId!,
              content: block.toolResult!,
            });
            previewImages.push(...(block.toolResultContent ?? []).filter((item) => item.type === "image" && item.imageData));
          }
          if (previewImages.length > 0) {
            result.push({
              role: "user",
              content: [
                { type: "text", text: "Visual previews returned by the preceding tool results." },
                ...previewImages.map((image) => ({
                  type: "image_url" as const,
                  image_url: { url: `data:${image.imageMediaType ?? "image/jpeg"};base64,${image.imageData}` },
                })),
              ],
            } as any);
          }
        } else {
          const images = msg.content.filter((b) => b.type === "image" && b.imageData);
          if (images.length > 0) {
            const parts: any[] = [];
            for (const b of msg.content) {
              if (b.type === "text" && b.text) {
                parts.push({ type: "text", text: b.text });
              } else if (b.type === "image" && b.imageData) {
                parts.push({
                  type: "image_url",
                  image_url: { url: `data:${b.imageMediaType ?? "image/png"};base64,${b.imageData}` },
                });
              }
            }
            result.push({ role: "user", content: parts } as any);
          } else {
            const text = msg.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n");
            result.push({ role: "user", content: text });
          }
        }
      } else if (msg.role === "assistant") {
        const text = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolCalls = msg.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({
            id: b.toolCallId!,
            type: "function" as const,
            function: {
              name: b.toolName!,
              arguments: JSON.stringify(b.toolInput),
            },
          }));

        result.push({
          role: "assistant",
          content: text || "",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    }

    return result;
  }

  private toChatTool(
    schema: ToolSchema,
  ): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: schema.name,
        description: schema.description,
        parameters: schema.inputSchema,
      },
    };
  }
}
