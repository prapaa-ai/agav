import { createHash } from "node:crypto";
import { applyEffortPrompt, supportsNativeEffort } from "./effort.js";
import type { ContentBlock, StreamEvent, StreamParams } from "./types.js";

/** Assemble complete, signed Claude blocks before storing them for replay. */
export class ClaudeThinkingBlocks {
  private blocks = new Map<number, ContentBlock>();

  accept(event: { type: string; index?: number; content_block?: any; delta?: any }): StreamEvent | undefined {
    if (event.index === undefined) return;
    const { index } = event;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "thinking") {
        this.blocks.set(index, { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" });
      } else if (block?.type === "redacted_thinking") {
        this.blocks.set(index, { type: "redacted_thinking", data: block.data });
      }
    } else if (event.type === "content_block_delta") {
      const block = this.blocks.get(index);
      if (block?.type === "thinking") {
        if (event.delta?.type === "thinking_delta") block.thinking += event.delta.thinking;
        if (event.delta?.type === "signature_delta") block.signature += event.delta.signature;
      }
    } else if (event.type === "content_block_stop") {
      const block = this.blocks.get(index);
      this.blocks.delete(index);
      if (block) return { type: "thinking_block", block };
    }
  }
}

export function toClaudeThinkingBlock(block: ContentBlock) {
  if (block.type === "thinking") return { type: "thinking" as const, thinking: block.thinking ?? "", signature: block.signature ?? "" };
  if (block.type === "redacted_thinking") return { type: "redacted_thinking" as const, data: block.data ?? "" };
  return undefined;
}

/** Hash the effective wire prefix, not credentials or the provider instance.
 * Stable across worker/session reloads; adapter/endpoint switches are not.
 */
export function claudeThinkingPrefix(adapter: string, model: string, params: StreamParams): string {
  const system = params.effort && supportsNativeEffort("anthropic", model)
    ? params.systemPrompt : applyEffortPrompt(params.systemPrompt, params.effort ?? "medium");
  return createHash("sha256").update(JSON.stringify([
    adapter, model, system ?? "",
    params.tools?.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) ?? [],
  ])).digest("hex");
}
