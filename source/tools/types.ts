import type { ToolSchema } from "../providers/types.js";
import type { ContentBlock } from "../providers/types.js";
import type { DiffLine } from "../utils/diff.js";

export interface ToolResult {
  output: string;
  isError: boolean;
  diffLines?: DiffLine[];
  contentBlocks?: ContentBlock[];
}

export interface ToolContext {
  env?: Record<string, string>;
}

export interface ToolDefinition {
  schema: ToolSchema;
  mcpServerName?: string;
  execute(input: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}
