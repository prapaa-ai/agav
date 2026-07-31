import type {
  LLMProvider,
  StreamParams,
  StreamEvent,
  Message,
  ToolSchema,
} from "./types.js";
import {
  applyEffortPrompt,
  supportsNativeEffort,
  mapGeminiThinkingBudget,
} from "./effort.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  thought?: boolean;
  thought_signature?: string;
  [key: string]: unknown;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private apiKey: string;
  // Store raw Gemini response parts per assistant turn so thought signatures
  // and thought blocks can be echoed back verbatim in the conversation history.
  // Keyed by the first synthetic toolCallId in that turn (or "__text_N__" for text-only turns).
  private rawTurnParts = new Map<string, GeminiPart[]>();
  private textTurnCounter = 0;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    let systemPrompt = params.systemPrompt;
    let thinkingBudget: number | undefined;

    if (params.effort && supportsNativeEffort("gemini", params.model)) {
      thinkingBudget = mapGeminiThinkingBudget(params.effort);
    }
    if (thinkingBudget === undefined) {
      systemPrompt = applyEffortPrompt(systemPrompt, params.effort ?? "medium");
    }

    const contents = this.toContents(params.messages);
    const tools = params.tools?.length
      ? [{ functionDeclarations: params.tools.map((t) => this.toTool(t)) }]
      : undefined;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: params.maxTokens ?? 16384,
        ...(thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget } }
          : {}),
      },
    };

    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    if (tools) {
      body.tools = tools;
    }

    const url = `${BASE_URL}/models/${params.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    yield { type: "message_start" };

    let callCounter = 0;
    const turnParts: GeminiPart[] = [];
    const turnCallIds: string[] = [];

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        if (chunk.usageMetadata) {
          yield {
            type: "usage",
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            cacheReadTokens: chunk.usageMetadata.cachedContentTokenCount ?? 0,
          };
        }

        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;

        for (const part of candidate.content.parts as GeminiPart[]) {
          // Store every raw part for later replay
          turnParts.push({ ...part });

          if (part.text !== undefined) {
            if (part.thought) {
              yield { type: "thinking_delta", text: part.text };
            } else {
              yield { type: "text_delta", text: part.text };
            }
          }

          if (part.functionCall) {
            const callId = `gemini_call_${callCounter++}`;
            turnCallIds.push(callId);
            yield { type: "tool_call_start", toolCallId: callId, toolName: part.functionCall.name };
            yield { type: "tool_call_delta", toolCallId: callId, argsJson: JSON.stringify(part.functionCall.args ?? {}) };
            yield { type: "tool_call_end", toolCallId: callId };
          }
        }

        if (candidate.finishReason) {
          const reason = candidate.finishReason === "STOP" ? "end_turn"
            : candidate.finishReason === "MAX_TOKENS" ? "max_tokens"
            : candidate.finishReason;
          yield { type: "message_end", stopReason: reason };
        }
      }
    }

    // Store raw parts keyed by each tool call ID in this turn
    if (turnCallIds.length > 0) {
      for (const id of turnCallIds) {
        this.rawTurnParts.set(id, turnParts);
      }
    } else {
      this.rawTurnParts.set(`__text_${this.textTurnCounter++}__`, turnParts);
    }
  }

  private toContents(messages: Message[]): GeminiContent[] {
    const result: GeminiContent[] = [];
    const idToName = new Map<string, string>();

    for (const msg of messages) {
      if (msg.role === "user") {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          const parts: GeminiPart[] = [];
          for (const block of toolResults) {
            const funcName = block.toolCallId ? idToName.get(block.toolCallId) : undefined;
            if (funcName) {
              parts.push({
                functionResponse: {
                  name: funcName,
                  response: { result: block.toolResult ?? "" },
                },
              });
            }
          }
          if (parts.length > 0) {
            this.pushContent(result, "user", parts);
          }
        } else {
          const parts: GeminiPart[] = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              parts.push({ text: block.text });
            } else if (block.type === "image" && block.imageData) {
              parts.push({
                inlineData: {
                  mimeType: block.imageMediaType ?? "image/png",
                  data: block.imageData,
                },
              });
            }
          }
          if (parts.length > 0) {
            this.pushContent(result, "user", parts);
          }
        }
      } else if (msg.role === "assistant") {
        // Check if we have stored raw parts for this turn (preserves thought signatures)
        const toolCallIds = msg.content
          .filter((b) => b.type === "tool_use" && b.toolCallId)
          .map((b) => b.toolCallId!);

        const rawParts = toolCallIds.length > 0
          ? this.rawTurnParts.get(toolCallIds[0]!)
          : undefined;

        if (rawParts) {
          // Use raw parts verbatim — they include thought blocks and thought_signature
          for (const block of msg.content) {
            if (block.type === "tool_use" && block.toolCallId && block.toolName) {
              idToName.set(block.toolCallId, block.toolName);
            }
          }
          this.pushContent(result, "model", rawParts);
        } else {
          // Fallback: reconstruct from ContentBlocks (no thought signatures — may fail on resume)
          const parts: GeminiPart[] = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              parts.push({ text: block.text });
            } else if (block.type === "tool_use") {
              if (block.toolCallId && block.toolName) {
                idToName.set(block.toolCallId, block.toolName);
              }
              parts.push({
                functionCall: {
                  name: block.toolName!,
                  args: (block.toolInput ?? {}) as Record<string, unknown>,
                },
              });
            }
          }
          if (parts.length > 0) {
            this.pushContent(result, "model", parts);
          }
        }
      }
    }

    return result;
  }

  // Gemini requires strict user/model alternation — merge consecutive same-role messages
  private pushContent(result: GeminiContent[], role: "user" | "model", parts: GeminiPart[]): void {
    const last = result[result.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      result.push({ role, parts });
    }
  }

  private toTool(schema: ToolSchema): Record<string, unknown> {
    return {
      name: schema.name,
      description: schema.description,
      parameters: this.cleanSchema(schema.inputSchema),
    };
  }

  // Gemini rejects JSON Schema fields it doesn't support
  private cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const UNSUPPORTED = new Set([
      "additionalProperties", "$schema", "id", "$id", "$ref",
      "definitions", "$defs", "patternProperties", "if", "then", "else",
      "allOf", "anyOf", "oneOf", "not", "dependentSchemas",
    ]);
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (UNSUPPORTED.has(key)) continue;
      if (key === "properties" && value && typeof value === "object") {
        const props: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
          props[pk] = pv && typeof pv === "object" && !Array.isArray(pv)
            ? this.cleanSchema(pv as Record<string, unknown>)
            : pv;
        }
        clean[key] = props;
      } else if (key === "items" && value && typeof value === "object" && !Array.isArray(value)) {
        clean[key] = this.cleanSchema(value as Record<string, unknown>);
      } else {
        clean[key] = value;
      }
    }
    return clean;
  }
}
