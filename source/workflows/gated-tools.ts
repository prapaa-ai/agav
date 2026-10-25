import type { AgavConfig } from "../config/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { isDestructiveCommand } from "../utils/sandbox.js";
import { validateToolInput, WORKFLOW_TOOLS } from "./definition.js";

/** Trusted application callbacks, never read from workflow definitions or tool input. */
/** Which workflow node a confirmation belongs to (used to key inbox decisions). */
export interface ToolCallContext { nodeId: string; iteration?: number[]; /** Decision kind for an uncovered call (default `tool_consent`; agent sub-tools use `agent_tool_consent`). */ kind?: "tool_consent" | "agent_tool_consent" }
export interface WorkflowExecutionHost {
  /** May throw `DecisionPendingError` to park the node on an inbox decision. */
  confirmTool: (name: string, input: Record<string, unknown>, signal: AbortSignal, context?: ToolCallContext) => Promise<boolean>;
  executeTool?: (registry: ToolRegistry, name: string, input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

/** Read-only built-ins that never need confirmation. */
export const SAFE_TOOLS: ReadonlySet<string> = new Set(["read_file", "grep_search", "find_files", "list_directory", "overview"]);
function allowed(name: string, input: Record<string, unknown>, rules: string[] = []): boolean {
  const primary = name === "run_command" ? String(input.command ?? "") : String(input.path ?? "");
  return rules.some(rule => {
    const colon = rule.indexOf(":");
    if (colon < 0) return rule === name;
    if (rule.slice(0, colon) !== name) return false;
    const pattern = rule.slice(colon + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${pattern}$`).test(primary);
  });
}
/** Headless foreground gate: no missing confirmation callback can imply consent. */
export async function gatedToolExecute(registry: ToolRegistry, name: string, input: Record<string, unknown>, config: AgavConfig, signal: AbortSignal, host?: WorkflowExecutionHost, callContext?: ToolCallContext): Promise<ToolResult> {
  signal.throwIfAborted();
  if (!WORKFLOW_TOOLS.includes(name as typeof WORKFLOW_TOOLS[number])) throw new Error(`Unsupported workflow tool: ${name}`);
  validateToolInput(registry, name, input);
  const safe = SAFE_TOOLS.has(name);
  if (name === "run_command" && isDestructiveCommand(String(input.command ?? ""))) throw new Error("Destructive commands are not supported by foreground workflows.");
  if (!safe && config.allowedTools?.length && !allowed(name, input, config.allowedTools)) throw new Error(`Tool '${name}' is not permitted in this mode.`);
  if (!safe && config.permissionMode === "deny-writes") throw new Error("Write operations are denied (--deny-writes mode).");
  if (!safe && config.permissionMode !== "auto-accept" && !allowed(name, input, config.allowedTools)) {
    if (!host) throw new Error(`Tool '${name}' requires confirmation but no confirmation handler is available (headless mode).`);
    if (!await host.confirmTool(name, input, signal, callContext)) throw new Error(`Tool '${name}' permission denied.`);
  }
  signal.throwIfAborted();
  const context: ToolContext = { signal, headless: !host, permissionMode: config.permissionMode };
  return host?.executeTool ? host.executeTool(registry, name, input, context) : registry.execute(name, input, context);
}

/**
 * Decides one sub-tool call made by an agent/prompt node's agent. Read-only SAFE tools are approved; destructive
 * commands, deny-writes and the config's allowedTools restriction refuse as for tool nodes; auto-accept
 * approves; anything else asks the host (keyed as `agent_tool_consent`, deduped per node and resolved input).
 * Consent for tool nodes never covers agent sub-tools: a consented tool name says nothing about agent input.
 * Returns false (the agent sees a denied call and continues) rather than failing the node.
 * A host may throw `DecisionPendingError`; the caller decides how to wait for it.
 */
export async function confirmAgentTool(name: string, input: Record<string, unknown>, config: AgavConfig, signal: AbortSignal, host: WorkflowExecutionHost | undefined, callContext: ToolCallContext): Promise<boolean> {
  if (signal.aborted) return false;
  const verdict = agentToolVerdict(name, input, config);
  if (verdict !== "ask") return verdict === "allow";
  if (!host) return false;
  return host.confirmTool(name, input, signal, { ...callContext, kind: "agent_tool_consent" });
}

/**
 * Host-independent part of `confirmAgentTool`: `deny` (destructive command, deny-writes, or outside the config's
 * allowedTools incl. path-scoped rules), `allow` (SAFE tool, auto-accept or allowlisted) or `ask` the host.
 */
export function agentToolVerdict(name: string, input: Record<string, unknown>, config: AgavConfig): "allow" | "deny" | "ask" {
  if (SAFE_TOOLS.has(name)) return "allow";
  if (name === "run_command" && isDestructiveCommand(String(input.command ?? ""))) return "deny";
  if (config.permissionMode === "deny-writes") return "deny";
  if (config.allowedTools?.length && !allowed(name, input, config.allowedTools)) return "deny";
  if (config.permissionMode === "auto-accept" || allowed(name, input, config.allowedTools)) return "allow";
  return "ask";
}
