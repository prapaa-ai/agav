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
  provider?: LLMProvider,
  /** Changes synchronously when the selected model or provider changes. */
  getModelSelectionVersion?: () => number,
  iterationsBudget?: { remaining: number, total: number },
  /**
   * Apply a model change. Returns an error message when the change is rejected
   * (e.g. the model violates the organization policy), or null on success, so a
   * command does not report a successful switch when the selection was blocked.
   */
  setModel: (model: string) => string | null
  /** Apply a provider change. Returns an error message when rejected, else null. */
  setProvider: (provider: AgavConfig["provider"]) => string | null
  setEffort: (effort: import("../config/config.js").EffortLevel) => void
  clearMessages: () => void
  /** Re-read the plan from disk so the on-screen plan panel matches it. */
  refreshPlan: () => void
  /** Open local dictation in the interactive composer; absent in headless mode. */
  startVoiceInput?: () => void
  showStatus: (text: string) => void
  saveSession: () => void
  refreshDisplay: () => void
  loadSession: (session: SessionRecord) => void
  activateSession: (id: string, name?: string) => void
  renameSession: (name: string) => void
  currentSessionId?: string
  exit: () => void
  /**
   * The permission mode actually in force for the session, after a generic
   * "Always" approval widens it and the org floor clamps it. Reflects the live
   * session decision, which `config.permissionMode` does not. Absent in headless
   * mode, where `config.permissionMode` is authoritative.
   */
  getEffectivePermissionMode?: () => AgavConfig["permissionMode"]
  /** Whether an agent turn is currently in flight. */
  isLoading?: boolean
  getMCPAuthenticationRequired?: () => string[]
  logoutMCPServer?: (name: string) => Promise<void>
  authenticateMCPServer?: (name: string) => Promise<void>
  getDebugState: () => DebugState
  submit: (text: string) => void
  handleSubmit: (text: string, invocationReason?: InvocationReason) => void
  toolRegistry: ToolRegistry
  addTokenUsage: (usage: TokenUsage) => void
  setRunningSkill: (name: string | null) => void
  createSkillProgressTracker?: (title: string, task: string) => (event: import("../agent/loop.js").AgentEvent) => void
  setPickerActive: (active: boolean) => void
  /**
   * Hand the terminal to a picker that writes to stdout directly, and get back
   * the function that returns it to Ink.
   *
   * Ink repaints on a throttle, so a frame committed after the picker has drawn
   * erases it by line count and leaves the screen mangled. Must be called
   * before the picker's first write, and must not be awaited in between.
   * Not needed by the React TUIs — those render inside Ink.
   */
  suspendTerminal: () => () => void
  /** Inline approval prompt for background-job actions; absent when no interactive UI can show one. */
  confirmBackgroundAction?: (
    action: import("../background-jobs/types.js").GrantAction,
    spec: Omit<import("../background-jobs/types.js").LaunchSpec, "requestId" | "createdAt">,
    subject?: import("../background-jobs/types.js").ConfirmSubject,
    signal?: AbortSignal,
  ) => Promise<boolean>
  /**
   * Per-invocation consent for a background workflow run (capabilities plus an env-var checklist).
   * Resolves the selected env NAMES, or undefined when denied; absent when no interactive UI can show it.
   */
  requestWorkflowConsent?: (request: import("../workflows/consent-prompt.js").ConsentRequest) => Promise<string[] | undefined>
  showResourceTUI?: (kind: import("../resources/types.js").ResourceKind, onDone: () => void, marketplace?: boolean) => void
  showAgentsTUI: (onDone: () => void) => void
  showSkillsTUI: (onDone: () => void) => void
  /** Open the /customize overlay; only the interactive app supplies this. */
  showCustomizeTUI?: (onDone: () => void) => void
}

/** Represents the result of executing a slash command. */
export type CommandResult =
  | {
      type: "message";
      text: string;
      /**
       * Render the text verbatim, skipping terminal path collapsing. Set by
       * commands like /status whose output intentionally shows the absolute
       * working directory, which would otherwise be rewritten to ".".
       */
      preservePaths?: boolean;
    }
  | { type: "clear" }
  | { type: "exit" }
  | { type: "none" }
  | { type: "submit"; text: string }
  | { type: "agent_invoke"; agentName: string; query: string }
  | { type: "skill_invoke"; skillName: string; arguments: string }

/** Defines the metadata and executor for a slash command. */
export interface SlashCommand {
  name: string
  description: string
  usage?: string
  execute(args: string, context: CommandContext): Promise<CommandResult>
}
