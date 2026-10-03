import type { ToolSchema } from "../providers/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { boundToolResult } from "../utils/tool-output.js";

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
    context?: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return boundToolResult({ output: `Unknown tool: ${name}`, isError: true });
    }
    let result: ToolResult;
    try {
      result = context?.signal?.aborted
        ? { output: "Tool cancelled.", isError: true }
        : await (context?.signal || context?.env ? tool.execute(input, context) : tool.execute(input));
    } catch (err) {
      result = {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
    return boundToolResult(result);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }
}
