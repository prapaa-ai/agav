import type { ToolCallInfo } from "../components/tool-call-display.js";

export interface SubagentProgress {
  id: string;
  title: string;
  task: string;
  status: "running" | "done" | "error";
  toolCalls: ToolCallInfo[];
  streamingText: string;
  result?: string;
  error?: string;
  startedAt: number;
  totalToolCalls: number;
  tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}
