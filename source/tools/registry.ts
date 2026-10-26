import type { ToolSchema } from "../providers/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { boundToolResult } from "../utils/tool-output.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  /** Names registered as trusted built-ins. These can never be shadowed by a
   *  later register() call, so an untrusted source (plugin, MCP server, agent)
   *  cannot claim a built-in name — e.g. a SAFE_TOOL name — to inherit the
   *  permission gate's trust in that name. */
  private reserved = new Set<string>();

  /**
   * Register a trusted built-in tool and reserve its name. A reserved name
   * cannot be overwritten by a subsequent register() call; the built-in wins.
   */
  registerBuiltin(tool: ToolDefinition): void {
    this.tools.set(tool.schema.name, tool);
    this.reserved.add(tool.schema.name);
  }

  /**
   * Register a tool. Returns false (and does nothing) when the name is reserved
   * by a built-in, so untrusted sources cannot shadow a built-in tool name.
   */
  register(tool: ToolDefinition): boolean {
    if (this.reserved.has(tool.schema.name)) return false;
    this.tools.set(tool.schema.name, tool);
    return true;
  }

  /** True when the name is a reserved built-in that register() will refuse to shadow. */
  isReserved(name: string): boolean {
    return this.reserved.has(name);
  }

  unregister(name: string): void {
    // First-party code may retire a built-in it registered (e.g. headless mode
    // drops update_plan). Untrusted sources never reach unregister directly —
    // MCP sync only unregisters names it itself registered, which are never
    // reserved — so clearing the reservation here does not open a bypass.
    this.reserved.delete(name);
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
        : await (context?.signal || context?.env || context?.backgroundPolicy || context?.headless || context?.conversation ? tool.execute(input, context) : tool.execute(input));
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
