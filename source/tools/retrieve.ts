import type { ToolDefinition, ToolResult } from "./types.js";
import { clearedStore } from "../agent/cleared-store.js";

/**
 * Retrieves the full original text of a tool result that context editing cleared
 * from the conversation to save tokens. The placeholder left in history names
 * the id to pass here. Reversible compression (CCR): the exact bytes come back,
 * with no need to re-run the original tool.
 */
export const retrieveTool: ToolDefinition = {
  schema: {
    name: "retrieve",
    description:
      "Retrieve the full original content of a tool result that was cleared to " +
      "save context. Pass the id shown in the '[tool result cleared …]' " +
      "placeholder. If the original is no longer available, re-run the tool that " +
      "produced it.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The cleared-result id from the placeholder (e.g. 'cleared-3').",
        },
      },
      required: ["id"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const id = String(input.id ?? "").trim();
    if (!id) {
      return { output: "retrieve requires an 'id'.", isError: true };
    }

    const original = clearedStore.get(id);
    if (original === undefined) {
      return {
        output:
          `No cleared result found for id "${id}". It may have been evicted from ` +
          `the cache or the session was resumed. Re-run the tool that produced it.`,
        isError: true,
      };
    }

    return { output: original, isError: false };
  },
};
