import type { AgavConfig } from "../config/config.js"
import type { ConversationState } from "../agent/conversation.js"
import type { LLMProvider } from "../providers/types.js"
import type { ToolRegistry } from "../tools/registry.js"
import type { SessionRecord } from "../config/history.js"
import type { InvocationReason } from "../providers/types.js"

/** Token accounting tracked for command-level debug output. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Captures runtime debug details surfaced through command handlers. */
export interface DebugState {
  tokenUsage: TokenUsage
  loadedPlugins: string[]
  mcpServers: string[]
  mcpResources: number
  mcpPrompts: number
}

/** Provides command handlers with access to app state and control hooks. */
export interface CommandContext {
  conversation: ConversationState
  config: AgavConfig
  provider?: LLMProvider
  setModel: (model: string) => void
  setProvider: (provider: AgavConfig["provider"]) => void
  setEffort: (effort: import("../config/config.js").EffortLevel) => void
  clearMessages: () => void
  showStatus: (text: string) => void
  saveSession: () => void
  refreshDisplay: () => void
  loadSession: (session: SessionRecord) => void
  activateSession: (id: string, name?: string) => void
  renameSession: (name: string) => void
  currentSessionId?: string
  exit: () => void
  getDebugState: () => DebugState
  submit: (text: string) => void
  handleSubmit: (text: string, invocationReason?: InvocationReason) => void
  toolRegistry: ToolRegistry
  addTokenUsage: (usage: TokenUsage) => void
  setRunningSkill: (name: string | null) => void
  setPickerActive: (active: boolean) => void
  showAgentsTUI: (onDone: () => void) => void
}

/** Represents the result of executing a slash command. */
export type CommandResult =
  | { type: "message"; text: string }
  | { type: "clear" }
  | { type: "exit" }
  | { type: "none" }
  | { type: "submit"; text: string }

/** Defines the metadata and executor for a slash command. */
export interface SlashCommand {
  name: string
  description: string
  usage?: string
  execute(args: string, context: CommandContext): Promise<CommandResult>
}
