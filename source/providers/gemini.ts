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
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

// Opt-in diagnostics for prefix-cache misses. Set AGAV_DEBUG_GEMINI=1 to log to
// /tmp/agav-gemini-debug.log, or to a path to choose the file. Writes to a file
// rather than stderr because stderr corrupts the Ink UI.
const DEBUG_TARGET = process.env["AGAV_DEBUG_GEMINI"];
const DEBUG_PATH = DEBUG_TARGET === "1" ? "/tmp/agav-gemini-debug.log" : DEBUG_TARGET;
let debugRequestCount = 0;

function sha8(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function debugLog(entry: Record<string, unknown>): void {
  if (!DEBUG_PATH) return;
  try {
    appendFileSync(DEBUG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    /* diagnostics must never break a turn */
  }
}

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
  // Must outlive a single stream() call, including concurrent child requests.
  private callCounter = 0;
  private readonly contextWindows = new Map<string, { value: number | undefined; expiresAt: number }>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /** The Gemini models.get endpoint reports the real window as `inputTokenLimit`. */
  async getContextWindow(model: string): Promise<number | undefined> {
    const cached = this.contextWindows.get(model);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const res = await fetch(`${BASE_URL}/models/${model}?key=${this.apiKey}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Gemini models API error ${res.status}`);
      const data = await res.json() as { inputTokenLimit?: number };
      const value = data.inputTokenLimit ?? undefined;
      this.contextWindows.set(model, { value, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
      return value;
    } catch {
      this.contextWindows.delete(model);
      return undefined;
    }
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

    // Per-message hashes pinpoint exactly where two consecutive requests stop
    // sharing a prefix, which is the only thing implicit caching keys on.
    const requestId = DEBUG_PATH ? ++debugRequestCount : 0;
    if (DEBUG_PATH) {
      const toolsJson = tools ? JSON.stringify(tools) : "";
      debugLog({
        req: requestId,
        model: params.model,
        sysSha: sha8(systemPrompt ?? ""),
        sysLen: (systemPrompt ?? "").length,
        toolsSha: sha8(toolsJson),
        toolsLen: toolsJson.length,
        msgCount: contents.length,
        msgShas: contents.map((c) => `${c.role[0]}:${sha8(JSON.stringify(c.parts))}`),
        bodyLen: JSON.stringify(body).length,
      });
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

    const turnParts: GeminiPart[] = [];
    const turnCallIds: string[] = [];
    // Gemini repeats usageMetadata on every SSE chunk and the counts are
    // cumulative, not deltas. Consumers add each usage event to a running
    // total, so emitting one per chunk multiplies the turn by the chunk count.
    // Keep only the latest and emit it once the stream is drained.
    let lastUsage: Extract<StreamEvent, { type: "usage" }> | null = null;
    let lastRawUsage: unknown = null;

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
          lastRawUsage = chunk.usageMetadata;
          lastUsage = {
            type: "usage",
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            // Gemini bills thinking tokens as output, separately from candidates.
            outputTokens: (chunk.usageMetadata.candidatesTokenCount ?? 0)
              + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
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
            const callId = `gemini_call_${this.callCounter++}`;
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

    // Emitted after message_end rather than before it: the final chunk may
    // carry a finishReason with no parts, in which case the loop above skips
    // it, so the end of the stream is the only reliable point. The agent loop
    // treats message_end as bookkeeping and keeps draining, so ordering here
    // does not lose the event.
    if (lastUsage) yield lastUsage;

    if (DEBUG_PATH) {
      debugLog({ req: requestId, usage: lastRawUsage });
    }

    // Publish only after draining: signatures or other opaque parts can arrive
    // after the function call, including in later chunks. The agent persists
    // metadata on the tool block, so replay belongs to history, not a shared
    // provider cache. Store the full turn once, on its first call.
    if (turnCallIds.length > 0) {
      yield {
        type: "tool_call_delta",
        toolCallId: turnCallIds[0]!,
        argsJson: "",
        providerMetadata: { geminiRawTurnParts: turnParts },
      };
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

        // A resumed session replays ids minted by an earlier process, whose
        // counter also started at zero. Keep newly minted ids above them so a
        // fresh call cannot claim a historical turn's key.
        for (const id of toolCallIds) {
          const match = /^gemini_call_(\d+)$/.exec(id);
          if (match) {
            this.callCounter = Math.max(this.callCounter, Number(match[1]) + 1);
          }
        }

        const storedParts = msg.content.find((block) => block.type === "tool_use"
          && Array.isArray(block.providerMetadata?.geminiRawTurnParts))
          ?.providerMetadata?.geminiRawTurnParts;
        const rawParts = Array.isArray(storedParts) ? storedParts as GeminiPart[] : undefined;

        if (rawParts) {
          // Use raw parts verbatim — they include thought blocks and thought_signature
          for (const block of msg.content) {
            if (block.type === "tool_use" && block.toolCallId && block.toolName) {
              idToName.set(block.toolCallId, block.toolName);
            }
          }
          this.pushContent(result, "model", rawParts);
        } else {
          // Synthetic calls and legacy history have no raw signed turn. Use the
          // compatibility sentinel here only; real turns above replay verbatim.
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
                thoughtSignature: "skip_thought_signature_validator",
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
      // Copy: provider metadata hands us a stored array, and a later merge into this
      // entry would otherwise mutate the cached turn in place.
      result.push({ role, parts: [...parts] });
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
