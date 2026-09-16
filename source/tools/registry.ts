import type { ToolSchema } from "../providers/types.js";
import type { ToolDefinition, ToolResult } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.schema.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  getSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((t) => t.schema);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      if (name === "finish" || name === "complete_task" || name === "done") {
        return {
          output: "Task completed successfully. Please present your final response directly in text to the user.",
          isError: false,
        };
      }
      return { output: `Unknown tool: ${name}`, isError: true };
    }
    try {
      return await tool.execute(input);
    } catch (err) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }
}
