export type Role = "user" | "assistant";

/** Explains when a turn or command was started by an automated workflow. */
export interface InvocationReason {
  source: "loop" | "schedule" | "watch";
  detail: string;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolResultContent?: ContentBlock[];
  isError?: boolean;
  imageData?: string;
  imageMediaType?: string;
  imageWidth?: number;
  imageHeight?: number;
  /** Provider-specific opaque state that must survive history persistence. */
  providerMetadata?: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: ContentBlock[];
  displayText?: string;
  sourceText?: string;
  invocationReason?: InvocationReason;
}

export type StreamEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string }
  | { type: "tool_call_delta"; toolCallId: string; argsJson: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "message_start" }
  | { type: "message_end"; stopReason: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: "error"; error: Error };

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StreamParams {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  systemPrompt?: string;
  effort?: import("../config/config.js").EffortLevel;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  stream(params: StreamParams): AsyncIterable<StreamEvent>;
}
