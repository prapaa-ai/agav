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
  /**
   * A user turn the agent injected to steer itself rather than one the user
   * typed. The model has to see it as a user turn, so it cannot be told apart
   * by role alone — but the transcript must never attribute it to the user.
   */
  internal?: boolean;
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
  destructive?: boolean; // true = always confirm; false = always safe; undefined = current SAFE_TOOLS logic
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
  /**
   * Real context window this provider will enforce for the model, when it can
   * be discovered at runtime. Optional: providers whose window is implied by
   * the model name leave it undefined and fall back to the name-based table.
   */
  getContextWindow?(model: string): Promise<number | undefined>;
}
