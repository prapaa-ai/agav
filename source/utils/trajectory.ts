import { writeFile } from "node:fs/promises";
import type { Message, ContentBlock } from "../providers/types.js";

/**
 * Native "agav trajectory" export used by non-interactive run/print modes.
 *
 * This is agav's own on-disk representation of a single run: the ordered
 * conversation (with tool_use / tool_result content blocks correlated by
 * toolCallId), aggregate token usage, and run timing. It is intentionally a
 * faithful dump of agav's internal structures — downstream consumers (e.g. the
 * Harbor/Terminal-Bench adapter) convert it into whatever interchange format
 * they need (ATIF, etc.), so we keep the schema here simple and stable.
 */

export interface AgavRunUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface AgavTrajectoryInput {
  model: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  usage: AgavRunUsage;
  messages: Message[];
}

/** Copy a content block, dropping large binary image payloads. */
function sanitizeBlock(block: ContentBlock): ContentBlock {
  const out: ContentBlock = { type: block.type };
  if (block.text !== undefined) out.text = block.text;
  if (block.toolCallId !== undefined) out.toolCallId = block.toolCallId;
  if (block.toolName !== undefined) out.toolName = block.toolName;
  if (block.toolInput !== undefined) out.toolInput = block.toolInput;
  if (block.toolResult !== undefined) out.toolResult = block.toolResult;
  if (block.isError !== undefined) out.isError = block.isError;
  if (block.toolResultContent) {
    out.toolResultContent = block.toolResultContent.map(sanitizeBlock);
  }
  // Never serialize base64 image bytes — they bloat the trajectory and add no
  // value to an auditable transcript. Leave a placeholder instead.
  if (block.type === "image") {
    out.text = block.text ?? "[image omitted]";
  }
  return out;
}

/** Serialize a completed run to a native agav trajectory JSON file. */
export async function writeAgavTrajectory(path: string, data: AgavTrajectoryInput): Promise<void> {
  const trajectory = {
    agav_trajectory_version: 1 as const,
    model: data.model,
    provider: data.provider,
    started_at: data.startedAt,
    finished_at: data.finishedAt,
    usage: data.usage,
    messages: data.messages.map((m) => ({
      role: m.role,
      ...(m.sourceText ? { sourceText: m.sourceText } : {}),
      ...(m.displayText ? { displayText: m.displayText } : {}),
      content: m.content.map(sanitizeBlock),
    })),
  };
  await writeFile(path, JSON.stringify(trajectory, null, 2), "utf-8");
}
