import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { applyEffortPrompt, mapOpenAIEffort, supportsNativeEffort } from "./effort.js";
import type { ContentBlock, LLMProvider, Message, StreamEvent, StreamParams, ToolSchema } from "./types.js";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_VERTEX_LOCATION = "global";
const THOUGHT_SIGNATURE_KEY = "vertexAIThoughtSignature";
const SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";

interface ServiceAccountCredentials {
  type: "service_account";
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** Load a service-account file and mint short-lived OAuth access tokens. */
export class VertexAIAuth {
  private credentials?: ServiceAccountCredentials;
  private token?: AccessToken;
  private pendingToken?: Promise<string>;

  constructor(private readonly credentialsPath: string) {}

  async getProjectId(): Promise<string> {
    return (await this.loadCredentials()).project_id;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    // Parallel callers (subagents, concurrent tool turns) share one in-flight
    // mint instead of each signing a JWT and racing to overwrite this.token.
    this.pendingToken ??= this.mintAccessToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async mintAccessToken(): Promise<string> {
    const credentials = await this.loadCredentials();
    const now = Math.floor(Date.now() / 1000);
    const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(JSON.stringify({
      iss: credentials.client_email,
      scope: CLOUD_PLATFORM_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }));
    const unsigned = `${header}.${claims}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    const assertion = `${unsigned}.${signer.sign(credentials.private_key, "base64url")}`;

    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Vertex AI authentication failed (${response.status}): ${detail}`);
    }
    const result = await response.json() as { access_token?: string; expires_in?: number };
    if (!result.access_token) throw new Error("Vertex AI authentication response did not include an access token");
    this.token = {
      value: result.access_token,
      expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private async loadCredentials(): Promise<ServiceAccountCredentials> {
    if (this.credentials) return this.credentials;
    let parsed: Partial<ServiceAccountCredentials>;
    try {
      parsed = JSON.parse(await readFile(this.credentialsPath, "utf8")) as Partial<ServiceAccountCredentials>;
    } catch (error) {
      throw new Error(`Unable to read Vertex AI credentials from ${this.credentialsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid Vertex AI service-account JSON at ${this.credentialsPath}: expected a JSON object`);
    }

    const requiredKeys = ["type", "project_id", "private_key", "client_email"] as const;
    const missingKeys = requiredKeys.filter((key) => {
      const value = parsed[key];
      return typeof value !== "string" || value.trim().length === 0;
    });
    if (missingKeys.length > 0) {
      throw new Error(
        `Invalid Vertex AI service-account JSON at ${this.credentialsPath}: missing required key${missingKeys.length === 1 ? "" : "s"}: ${missingKeys.join(", ")}`,
      );
    }
    if (parsed.type !== "service_account") {
      throw new Error(
        `Invalid Vertex AI service-account JSON at ${this.credentialsPath}: key "type" must be "service_account" (received ${JSON.stringify(parsed.type)})`,
      );
    }
    this.credentials = parsed as ServiceAccountCredentials;
    return this.credentials;
  }
}

/**
 * The multi-region "global" endpoint lives on the bare host; every other
 * location is served from its own regional host.
 */
function vertexHost(location: string): string {
  return location === DEFAULT_VERTEX_LOCATION
    ? "https://aiplatform.googleapis.com"
    : `https://${encodeURIComponent(location)}-aiplatform.googleapis.com`;
}

function vertexBaseUrl(projectId: string, location: string): string {
  return `${vertexHost(location)}/v1beta1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/endpoints/openapi`;
}

function vertexModelName(model: string): string {
  if (model.startsWith("vertex/")) return `google/${model.slice("vertex/".length)}`;
  return model.includes("/") ? model : `google/${model}`;
}

function isClaudeModel(model: string): boolean {
  return /(?:^|\/)claude-/i.test(model);
}

function vertexClaudeModelName(model: string): string {
  return model
    .replace(/^vertex\//i, "")
    .replace(/^anthropic\//i, "")
    .replace(/^publishers\/anthropic\/models\//i, "");
}

function vertexClaudeUrl(projectId: string, model: string, location: string): string {
  return `${vertexHost(location)}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/anthropic/models/${encodeURIComponent(vertexClaudeModelName(model))}:streamRawPredict`;
}

function extractThoughtSignature(value: any): string | undefined {
  const signature = value?.extra_content?.google?.thought_signature
    ?? value?.extraContent?.google?.thoughtSignature
    ?? value?.thought_signature
    ?? value?.thoughtSignature;
  return typeof signature === "string" && signature ? signature : undefined;
}

function addMissingThoughtSignatureSentinels(body: Record<string, unknown>): Record<string, unknown> {
  const repaired = structuredClone(body) as any;
  for (const message of repaired.messages ?? []) {
    if (message?.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (!extractThoughtSignature(call)) {
        call.extra_content = {
          ...(call.extra_content ?? {}),
          google: {
            ...(call.extra_content?.google ?? {}),
            thought_signature: SKIP_THOUGHT_SIGNATURE_VALIDATOR,
          },
        };
      }
    }
  }
  return repaired;
}

export class VertexAIProvider implements LLMProvider {
  readonly name = "vertex-ai";
  private readonly auth: VertexAIAuth;
  private readonly location: string;

  constructor(credentialsPath: string, location?: string) {
    this.auth = new VertexAIAuth(credentialsPath);
    this.location = location || DEFAULT_VERTEX_LOCATION;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    if (isClaudeModel(params.model)) {
      yield* this.streamClaude(params);
      return;
    }
    if (!/(?:^|\/)gemini-/i.test(params.model)) {
      throw new Error(`Unsupported Vertex AI model "${params.model}". Agav supports Gemini and Claude models through Vertex AI.`);
    }
    yield* this.streamGemini(params);
  }

  private async *streamGemini(params: StreamParams): AsyncIterable<StreamEvent> {
    const projectId = await this.auth.getProjectId();
    const accessToken = await this.auth.getAccessToken();
    const systemPrompt = params.systemPrompt;
    const body: Record<string, unknown> = {
      model: vertexModelName(params.model),
      messages: this.toMessages(params.messages, systemPrompt, true),
      tools: params.tools?.length ? params.tools.map((tool) => this.toTool(tool)) : undefined,
      tool_choice: params.tools?.length ? "auto" : undefined,
      max_tokens: params.maxTokens ?? 16384,
      stream: true,
      stream_options: { include_usage: true },
      ...(params.effort ? { reasoning_effort: params.effort === "max" ? "high" : mapOpenAIEffort(params.effort) } : {}),
    };

    // Vertex AI implicit prompt caching is enabled automatically. Keeping the
    // system prompt, tools, and message history in a stable prefix lets repeat
    // turns reuse it without creating and managing explicit cache resources.
    const requestUrl = `${vertexBaseUrl(projectId, this.location)}/chat/completions`;
    const send = (requestBody: Record<string, unknown>) => fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: params.signal,
    });
    let response = await send(body);
    if (!response.ok && response.status === 400) {
      const detail = await response.text().catch(() => "");
      if (/missing a thought_signature|thought signature.*required/i.test(detail)) {
        response = await send(addMissingThoughtSignatureSentinels(body));
      } else {
        throw new Error(`Vertex AI API error ${response.status}: ${detail}`);
      }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Vertex AI API error ${response.status}: ${detail}`);
    }
    if (!response.body) throw new Error("Vertex AI response did not include a body");

    yield { type: "message_start" };
    const activeCalls = new Map<number, { id: string; name: string }>();
    const pendingSignatures = new Map<number, string>();
    let lastToolCallIndex: number | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const parseLine = function* (line: string): Generator<StreamEvent> {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk: any;
      try { chunk = JSON.parse(payload); } catch { return; }
      if (chunk.error) {
        yield { type: "error", error: new Error(chunk.error.message ?? JSON.stringify(chunk.error)) };
        return;
      }
      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      const messageSignature = extractThoughtSignature(delta) ?? extractThoughtSignature(choice);
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (typeof thought === "string" && thought) yield { type: "thinking_delta", text: thought };
      if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", text: delta.content };
      // A message-level signature carries no index of its own. Attribute it to
      // a tool call in the same delta when there is one, otherwise to the call
      // that is currently streaming — assuming index 0 misfiles the signature
      // whenever the model emits parallel tool calls.
      if (messageSignature) {
        const sameDeltaIndex = delta.tool_calls?.[0]?.index;
        const target = sameDeltaIndex ?? lastToolCallIndex ?? 0;
        if (!pendingSignatures.has(target)) pendingSignatures.set(target, messageSignature);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        lastToolCallIndex = index;
        const thoughtSignature = extractThoughtSignature(call) ?? extractThoughtSignature(call.function);
        if (thoughtSignature) pendingSignatures.set(index, thoughtSignature);
        if (call.function?.name) {
          const id = call.id ?? `vertex_call_${index}`;
          activeCalls.set(index, { id, name: call.function.name });
          yield { type: "tool_call_start", toolCallId: id, toolName: call.function.name };
        }
        const active = activeCalls.get(index);
        if (active && (call.function?.arguments || pendingSignatures.has(index))) {
          const signature = pendingSignatures.get(index);
          yield {
            type: "tool_call_delta",
            toolCallId: active.id,
            argsJson: call.function?.arguments ?? "",
            ...(signature ? { providerMetadata: { [THOUGHT_SIGNATURE_KEY]: signature } } : {}),
          };
          pendingSignatures.delete(index);
        }
      }
      // Some Vertex streaming versions emit the signature as assistant-delta
      // metadata after the tool-call delta rather than inside tool_calls[].
      for (const [index, signature] of pendingSignatures) {
        const active = activeCalls.get(index);
        if (!active) continue;
        yield {
          type: "tool_call_delta",
          toolCallId: active.id,
          argsJson: "",
          providerMetadata: { [THOUGHT_SIGNATURE_KEY]: signature },
        };
        pendingSignatures.delete(index);
      }
      if (choice.finish_reason) {
        for (const active of activeCalls.values()) yield { type: "tool_call_end", toolCallId: active.id };
        activeCalls.clear();
        yield { type: "message_end", stopReason: choice.finish_reason };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) yield* parseLine(line);
      if (done) break;
    }
    if (buffer.trim()) yield* parseLine(buffer.trim());
  }

  private async *streamClaude(params: StreamParams): AsyncIterable<StreamEvent> {
    const projectId = await this.auth.getProjectId();
    const accessToken = await this.auth.getAccessToken();
    const model = vertexClaudeModelName(params.model);
    const nativeEffort = params.effort && supportsNativeEffort("anthropic", model)
      ? params.effort
      : undefined;
    const systemPrompt = nativeEffort
      ? params.systemPrompt
      : applyEffortPrompt(params.systemPrompt, params.effort ?? "medium");
    const tools = params.tools?.map((tool, index, all) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(index === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
    const body: Record<string, unknown> = {
      anthropic_version: "vertex-2023-10-16",
      messages: this.toClaudeMessages(params.messages),
      max_tokens: params.maxTokens ?? 16384,
      stream: true,
      ...(systemPrompt ? { system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }] } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(nativeEffort ? { output_config: { effort: nativeEffort } } : {}),
    };
    const response = await fetch(vertexClaudeUrl(projectId, model, this.location), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Vertex AI Claude API error ${response.status}: ${detail}`);
    }
    if (!response.body) throw new Error("Vertex AI Claude response did not include a body");

    yield { type: "message_start" };
    const blockToolIds = new Map<number, string>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const parseLine = function* (line: string): Generator<StreamEvent> {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let event: any;
      try { event = JSON.parse(payload); } catch { return; }
      if (event.type === "error") {
        yield { type: "error", error: new Error(event.error?.message ?? JSON.stringify(event.error ?? event)) };
      } else if (event.type === "message_start") {
        const usage = event.message?.usage;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          };
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block?.type === "tool_use") {
          blockToolIds.set(event.index, event.content_block.id);
          yield {
            type: "tool_call_start",
            toolCallId: event.content_block.id,
            toolName: event.content_block.name,
          };
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
          yield { type: "thinking_delta", text: event.delta.thinking };
        } else if (event.delta?.type === "text_delta" && event.delta.text) {
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta?.type === "input_json_delta") {
          const toolCallId = blockToolIds.get(event.index);
          if (toolCallId) yield { type: "tool_call_delta", toolCallId, argsJson: event.delta.partial_json ?? "" };
        }
      } else if (event.type === "content_block_stop") {
        const toolCallId = blockToolIds.get(event.index);
        if (toolCallId) {
          yield { type: "tool_call_end", toolCallId };
          blockToolIds.delete(event.index);
        }
      } else if (event.type === "message_delta") {
        const outputTokens = event.usage?.output_tokens ?? 0;
        if (outputTokens > 0) yield { type: "usage", inputTokens: 0, outputTokens };
        yield { type: "message_end", stopReason: event.delta?.stop_reason ?? "end_turn" };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) yield* parseLine(line);
      if (done) break;
    }
    if (buffer.trim()) yield* parseLine(buffer.trim());
  }

  private toClaudeMessages(messages: Message[]): Record<string, unknown>[] {
    return messages.map((message) => ({
      role: message.role,
      content: message.content.map((block) => this.toClaudeContentBlock(block)),
    }));
  }

  private toClaudeContentBlock(block: ContentBlock): Record<string, unknown> {
    if (block.type === "text") return { type: "text", text: block.text ?? "" };
    if (block.type === "tool_use") {
      return { type: "tool_use", id: block.toolCallId, name: block.toolName, input: block.toolInput ?? {} };
    }
    if (block.type === "tool_result") {
      const nested = block.toolResultContent
        ?.filter((item) => item.type === "text" || (item.type === "image" && item.imageData))
        .map((item) => item.type === "image"
          ? {
              type: "image",
              source: { type: "base64", media_type: item.imageMediaType ?? "image/jpeg", data: item.imageData },
            }
          : { type: "text", text: item.text ?? "" });
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: nested?.length ? nested : block.toolResult ?? "",
        ...(block.isError !== undefined ? { is_error: block.isError } : {}),
      };
    }
    if (block.type === "image" && block.imageData) {
      return {
        type: "image",
        source: { type: "base64", media_type: block.imageMediaType ?? "image/png", data: block.imageData },
      };
    }
    return { type: "text", text: block.text ?? "" };
  }

  private toMessages(messages: Message[], systemPrompt?: string, requiresThoughtSignatures = false): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    const toolNames = new Map<string, string>();
    if (systemPrompt) result.push({ role: "system", content: systemPrompt });
    for (const message of messages) {
      if (message.role === "user") {
        const toolResults = message.content.filter((block) => block.type === "tool_result");
        if (toolResults.length) {
          for (const block of toolResults) {
            result.push({
              role: "tool",
              tool_call_id: block.toolCallId,
              name: block.toolCallId ? toolNames.get(block.toolCallId) : undefined,
              content: block.toolResult ?? "",
            });
          }
          const images = toolResults.flatMap((block) => block.toolResultContent ?? []).filter((block) => block.type === "image" && block.imageData);
          if (images.length) result.push({ role: "user", content: this.imageParts(images, "Visual previews returned by the preceding tool results.") });
        } else {
          const images = message.content.filter((block) => block.type === "image" && block.imageData);
          if (images.length) result.push({ role: "user", content: this.contentParts(message.content) });
          else result.push({ role: "user", content: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") });
        }
      } else {
        const content = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        const toolBlocks = message.content.filter((block) => block.type === "tool_use");
        for (const block of toolBlocks) {
          if (block.toolCallId && block.toolName) toolNames.set(block.toolCallId, block.toolName);
        }
        const hasStoredSignature = toolBlocks.some((block) => typeof block.providerMetadata?.[THOUGHT_SIGNATURE_KEY] === "string");
        const toolCalls = toolBlocks.map((block, index) => {
          const storedSignature = block.providerMetadata?.[THOUGHT_SIGNATURE_KEY];
          // Sessions created before signature persistence have no opaque state
          // to replay. Vertex documents this sentinel for externally-created
          // function calls; use it only on the first call in that old turn.
          const thoughtSignature = typeof storedSignature === "string"
            ? storedSignature
            : requiresThoughtSignatures && !hasStoredSignature && index === 0
              ? SKIP_THOUGHT_SIGNATURE_VALIDATOR
              : undefined;
          return {
            id: block.toolCallId,
            type: "function",
            function: { name: block.toolName, arguments: JSON.stringify(block.toolInput ?? {}) },
            ...(thoughtSignature ? { extra_content: { google: { thought_signature: thoughtSignature } } } : {}),
          };
        });
        result.push({ role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      }
    }
    return result;
  }

  private contentParts(content: ContentBlock[]): Record<string, unknown>[] {
    return content.flatMap((block): Record<string, unknown>[] => {
      if (block.type === "text" && block.text) return [{ type: "text", text: block.text }];
      if (block.type === "image" && block.imageData) return [{ type: "image_url", image_url: { url: `data:${block.imageMediaType ?? "image/png"};base64,${block.imageData}` } }];
      return [];
    });
  }

  private imageParts(images: ContentBlock[], intro: string): Record<string, unknown>[] {
    return [{ type: "text", text: intro }, ...this.contentParts(images)];
  }

  private toTool(schema: ToolSchema): Record<string, unknown> {
    return { type: "function", function: { name: schema.name, description: schema.description, parameters: schema.inputSchema } };
  }
}

/** List Gemini and Claude publisher models that can be selected for Vertex AI chat. */
export async function fetchVertexAIModels(credentialsPath: string, location?: string): Promise<string[]> {
  const auth = new VertexAIAuth(credentialsPath);
  const token = await auth.getAccessToken();
  const host = vertexHost(location || DEFAULT_VERTEX_LOCATION);
  const fetchPublisher = async (publisher: "google" | "anthropic"): Promise<string[]> => {
    const models: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${host}/v1beta1/publishers/${publisher}/models`);
      url.searchParams.set("pageSize", "100");
      if (publisher === "anthropic") url.searchParams.set("listAllVersions", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Vertex AI ${publisher} models API error ${response.status}`);
      const data = await response.json() as { publisherModels?: { name?: string }[]; nextPageToken?: string };
      for (const model of data.publisherModels ?? []) {
        const pattern = publisher === "google"
          ? /publishers\/google\/models\/(gemini-[^@/]+)/
          : /publishers\/anthropic\/models\/(claude-[^/]+)/;
        const match = pattern.exec(model.name ?? "");
        if (!match) continue;
        if (publisher === "google" && /tts/i.test(match[1]!)) continue;
        models.push(`vertex/${match[1]}`);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return models;
  };

  const results = await Promise.allSettled([fetchPublisher("google"), fetchPublisher("anthropic")]);
  const models = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const failures = results.filter((result) => result.status === "rejected");
  // Surface the failure whenever it left us with nothing to show. Requiring
  // *every* publisher to fail hid the case where one errored and the other
  // legitimately returned an empty list, which looked like "no models exist".
  if (models.length === 0 && failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Unable to list Vertex AI Gemini or Claude models",
    );
  }
  return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}
