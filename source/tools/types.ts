import type { ToolSchema } from "../providers/types.js";
import type { ContentBlock } from "../providers/types.js";
import type { DiffLine } from "../utils/diff.js";

export interface ToolResult {
  output: string;
  isError: boolean;
  diffLines?: DiffLine[];
  contentBlocks?: ContentBlock[];
  /** Structured test evidence; absent metadata is not verification. */
  verification?: {
    status: "passed" | "failed" | "inconclusive";
    passed: number;
    failed: number;
    errors: number;
    /** Null when the process did not exit normally (spawn error, signal, etc.). */
    exitCode: number | null;
  };
}

export interface ToolContext {
  env?: Record<string, string>;
  /**
   * Abort signal for the operation that invoked this tool. Lets a long-running
   * tool stop promptly when its workflow is cancelled or times out, instead of
   * being abandoned mid-flight.
   */
  signal?: AbortSignal;
  /**
   * Stable key for the current logical operation, supplied by a workflow node so
   * retries and resumes can deduplicate side effects. Undefined outside workflow
   * execution.
   */
  idempotencyKey?: string;
}

export interface ToolDefinition {
  schema: ToolSchema;
  mcpServerName?: string;
  execute(input: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>;
}
