import type { ToolSchema } from "../providers/types.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private defaultContext?: ToolContext;

  constructor(defaultContext?: ToolContext) {
    this.defaultContext = defaultContext;
  }

  setDefaultContext(context?: ToolContext): void {
    this.defaultContext = context;
  }

  getDefaultContext(): ToolContext | undefined {
    return this.defaultContext;
  }

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
      return { output: `Unknown tool: ${name}`, isError: true };
    }
    const hasContext = Boolean(this.defaultContext || context);
    const mergedContext: ToolContext | undefined = hasContext
      ? { ...this.defaultContext, ...context }
      : undefined;
    try {
      return mergedContext
        ? await tool.execute(input, mergedContext)
        : await tool.execute(input);
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
