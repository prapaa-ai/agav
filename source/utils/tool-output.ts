import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../tools/types.js";

// Approximate 10k tokens for ordinary code/logs, not a tokenizer-exact limit.
// Apply both limits: a huge minified line and thousands of short lines are costly.
export const MAX_TOOL_OUTPUT_BYTES = 40_000;
export const MAX_TOOL_OUTPUT_LINES = 2_000;

function utf8Slice(bytes: Buffer, start: number, end: number): string {
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(start, end).toString("utf8");
}

/** Keep a prefix and suffix within a byte AND line budget, including the notice. */
export function truncateToolText(text: string, notice: string): string {
  const marker = "\n\n[... middle omitted ...]\n\n";
  const footer = `\n\n${notice}`;
  const budget = Math.max(0, MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(marker + footer));
  const lineBudget = Math.max(2, MAX_TOOL_OUTPUT_LINES - (marker + footer).split("\n").length);
  const bytes = Buffer.from(text);
  const headBytes = Math.floor(budget / 2);
  const tailBytes = budget - headBytes;
  const head = utf8Slice(bytes, 0, Math.min(headBytes, bytes.length))
    .split("\n").slice(0, Math.floor(lineBudget / 2)).join("\n");
  const tail = utf8Slice(bytes, Math.max(Buffer.byteLength(head), bytes.length - tailBytes), bytes.length)
    .split("\n").slice(-Math.ceil(lineBudget / 2)).join("\n");
  return head + marker + tail + footer;
}

/** Persist before advertising a path. Files may contain private command/API data. */
async function saveToolOutput(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agav-tool-output-"));
  const pending = join(directory, "output.pending");
  const path = join(directory, "output.txt");
  try {
    await writeFile(pending, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(pending, path);
    return path;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function oversized(text: string): boolean {
  if (Buffer.byteLength(text) > MAX_TOOL_OUTPUT_BYTES) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && ++lines > MAX_TOOL_OUTPUT_LINES) return true;
  }
  return false;
}

async function boundText(text: string): Promise<string> {
  if (!oversized(text)) return text;
  let notice: string;
  try {
    const path = await saveToolOutput(text);
    notice = `[Output truncated. Complete returned text: ${JSON.stringify(path)}. Use read_file with start_line/end_line or grep_search on this path to retrieve specific sections.]`;
  } catch {
    // Disk-full/permissions must not change tool success or repeat side effects.
    notice = "[Output truncated. Could not save the complete returned text; omitted content is unavailable. Narrow the query if more detail is needed.]";
  }
  return truncateToolText(text, notice);
}

/** Shared boundary for built-ins, plugins, MCP tools, skills and subagents. */
export async function boundToolResult(result: ToolResult): Promise<ToolResult> {
  const texts = result.contentBlocks?.filter((block) => block.type === "text");
  // Providers consume contentBlocks instead of output when they exist. Display
  // output may differ; preserve and bound both rather than silently losing one.
  const contentText = texts?.map((block) => block.text ?? "").join("\n") ?? "";
  if (!oversized(contentText) && !oversized(result.output)) return result;
  const output = await boundText(result.output);
  const boundedContent = contentText === result.output ? output : await boundText(contentText);
  let firstText = true;
  const contentBlocks = oversized(contentText) ? result.contentBlocks?.flatMap((block) => {
    if (block.type !== "text") return [block];
    if (!firstText) return [];
    firstText = false;
    return [{ ...block, text: boundedContent }];
  }) : result.contentBlocks;
  return { ...result, output, contentBlocks };
}
