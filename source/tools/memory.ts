import type { ToolDefinition, ToolResult } from "./types.js";
import { saveMemory, type MemoryType } from "../config/memory.js";

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

export const memoryTool: ToolDefinition = {
  schema: {
    name: "save_memory",
    description:
      "Save a memory for future sessions. Use this proactively when you detect:\n" +
      "- User corrections ('don't do X', 'stop doing Y') → type: feedback\n" +
      "- User confirms an approach ('yes exactly', 'perfect') → type: feedback\n" +
      "- User shares role/expertise info ('I'm a data scientist') → type: user\n" +
      "- Project decisions, deadlines, or context → type: project\n" +
      "- Pointers to external resources (Linear, Slack, dashboards) → type: reference\n" +
      "Do NOT save code patterns, file paths, or anything derivable from the codebase.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short kebab-case slug (e.g. 'prefer-tabs', 'user-role')",
        },
        description: {
          type: "string",
          description: "One-line summary — used to decide relevance in future sessions",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "Memory type: user (role/prefs), feedback (corrections/confirmations), project (decisions/context), reference (external pointers)",
        },
        content: {
          type: "string",
          description: "Memory content. For feedback/project types, structure as: rule/fact, then Why: and How to apply: lines",
        },
      },
      required: ["name", "description", "type", "content"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const name = String(input.name ?? "").trim();
    const description = String(input.description ?? "").trim();
    const type = String(input.type ?? "project") as MemoryType;
    const content = String(input.content ?? "").trim();

    if (!name || !description || !content) {
      return { output: "Missing required fields: name, description, and content are all required.", isError: true };
    }

    if (!VALID_TYPES.has(type)) {
      return { output: `Invalid type "${type}". Must be: user, feedback, project, or reference.`, isError: true };
    }

    try {
      const id = await saveMemory({ name, description, type, content });
      return { output: `Memory saved: ${name} (${id})`, isError: false };
    } catch (err) {
      return {
        output: `Failed to save memory: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
