import { useState, useCallback, useRef, useEffect } from "react";
import { useApp } from "../ink/index.js";
import type { DisplayMessage } from "../components/message-list.js";
import type { ToolCallInfo } from "../components/tool-call-display.js";
import type { LLMProvider, ContentBlock, InvocationReason, Message } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import { isInternalUserMessage } from "../agent/internal-prompts.js";
import { createToolRegistry } from "../tools/registry-factory.js";
import type { ToolRegistry } from "../tools/registry.js";
import { saveSession, type SessionRecord } from "../config/history.js";
import { saveSessionState } from "../config/session-state.js";
import {
  shouldAutoPlan,
  savePlan,
  loadPlan,
  clearPlan,
  isPlanActive,
  setPlanScope,
  adoptPlanScope,
  prunePlans,
  formatPlanForPrompt,
  ensurePlanFile,
  type Plan,
} from "../agent/planner.js";
import { MCPManager } from "../mcp/manager.js";
import { createPromptCommand } from "../mcp/prompt-command.js";
import type { SlashCommand } from "../commands/types.js";
import { loadPlugins } from "../plugins/loader.js";
import { createSubagentTool } from "../tools/subagent.js";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";
import type { SubagentProgress } from "../agent/subagent-types.js";
import { expandFileMentions } from "../utils/file-mentions.js";
import { loadSkills, getCachedSkills } from "../skills/loader.js";
import { createSkillTool } from "../skills/tool.js";
import { createSkillSlashCommand } from "../skills/commands.js";
import { maybeRunBackgroundImprovement } from "../skills/improvement.js";
import { drainSteers } from "../commands/steer.js";

let messageId = 0;
/** Generate incremental display ids so transient UI rows have stable React keys. */
function nextId(): string {
  return String(++messageId);
}

/**
 * Rebuild the visible transcript from the conversation the model sees — on
 * resume, and whenever the screen is redrawn. The two are not the same list:
 * the conversation also carries prompts the agent wrote to steer itself, and
 * carries the user's turns as they were sent rather than as they were typed.
 */
export function messagesToDisplay(msgs: Message[]): DisplayMessage[] {
  const displayMsgs: DisplayMessage[] = [];
  for (const msg of msgs) {
    // Prompts the agent injected to steer itself are user turns to the model
    // only; rebuilding the transcript from them is what made a resumed session
    // quote its own instructions back at the user.
    if (isInternalUserMessage(msg)) continue;
    // Falling through to the raw blocks would show the text as sent rather
    // than as typed — @mentions expanded, per-turn context appended.
    const rendered = msg.displayText ?? msg.sourceText;
    if (rendered) {
      displayMsgs.push({
        id: nextId(),
        role: msg.role === "user" ? "user" : "assistant",
        content: rendered,
        sourceText: msg.sourceText,
        invocationReason: msg.invocationReason,
      });
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        displayMsgs.push({
          id: nextId(),
          role: msg.role === "user" ? "user" : "assistant",
          content: block.text,
        });
      }
    }
  }
  return displayMsgs;
}

/**
 * How many times the plan auto-continue may resubmit a step that has not moved
 * off `pending`/`in_progress` before it stops and hands control back.
 */
const MAX_PLAN_STEP_ATTEMPTS = 3;

import type { ConfirmResult } from "../agent/loop.js";
import type { DiffLine } from "../utils/diff.js";

export interface PendingConfirmation {
  toolName: string;
  input: Record<string, unknown>;
  diffLines?: DiffLine[];
  resolve: (choice: ConfirmResult) => void;
  subagentId?: string;
  subagentTask?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface UseAgentReturn {
  messages: DisplayMessage[];
  streamingText: string;
  thinkingText: string;
  isLoading: boolean;
  toolCalls: ToolCallInfo[];
  error: string | null;
  pendingConfirmation: PendingConfirmation | null;
  tokenUsage: TokenUsage;
  loadedPlugins: string[];
  mcpServers: string[];
  mcpPromptCommands: SlashCommand[];
  skillCommands: SlashCommand[];
  mcpResourceCount: number;
  mcpPromptCount: number;
  subagentStates: SubagentProgress[];
  activePlan: Plan | null;
  refreshPlan: () => void;
  submit: (input: string, extraBlocks?: ContentBlock[], displayText?: string, followUpMessages?: DisplayMessage[], invocationReason?: InvocationReason) => Promise<boolean>;
  addDisplayMessage: (msg: DisplayMessage) => void;
  cancel: () => void;
  clearMessages: () => void;
  confirmTool: (choice: ConfirmResult) => void;
  conversation: ConversationState;
  toolRegistry: ToolRegistry;
  saveNow: (extraUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  refreshDisplay: () => void;
  addTokenUsage: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  loadSession: (session: SessionRecord) => void;
  activateSession: (id: string, name?: string) => void;
  renameSession: (name: string) => void;
  sessionId: string | undefined;
  sessionName: string | undefined;
  transcriptRevision: number;
  turnStartTime: number | null;
  lastTurnDurationMs: number | null;
}

/** Own the agent lifecycle, conversation state, tool events, persistence, and confirmations. */
export function useAgent(
  provider: LLMProvider | null,
  config: AgavConfig,
  resumeMessages?: import("../providers/types.js").Message[],
  resumeSessionId?: string,
  resumeTokenUsage?: import("../config/history.js").SessionTokenUsage,
  resumeCompacted?: boolean,
  resumeSessionName?: string,
): UseAgentReturn {
  const { resetDisplay } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [turnStartTime, setTurnStartTime] = useState<number | null>(null);
  const turnStartTimeRef = useRef<number | null>(null);
  const [lastTurnDurationMs, setLastTurnDurationMs] = useState<number | null>(null);
  /** Set turn start time in both state (for UI) and ref (for synchronous reads). */
  const updateTurnStart = useCallback((ts: number | null) => {
    turnStartTimeRef.current = ts;
    setTurnStartTime(ts);
  }, []);
  /** Finalize the turn timer: compute duration from the ref, then clear both. */
  const finalizeTurnTimer = useCallback(() => {
    const start = turnStartTimeRef.current;
    if (start !== null) {
      setLastTurnDurationMs(Date.now() - start);
    }
    turnStartTimeRef.current = null;
    setTurnStartTime(null);
  }, []);
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>(resumeTokenUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const [loadedPlugins, setLoadedPlugins] = useState<string[]>([]);
  const sessionIdRef = useRef<string | null>(resumeSessionId ?? null);
  const [sessionId, setSessionId] = useState<string | undefined>(resumeSessionId);
  const sessionNameRef = useRef<string | undefined>(resumeSessionName);
  const [sessionName, setSessionName] = useState<string | undefined>(resumeSessionName);
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [mcpPromptCommands, setMcpPromptCommands] = useState<SlashCommand[]>([]);
  const [skillCommands, setSkillCommands] = useState<SlashCommand[]>([]);
  const [mcpResourceCount, setMcpResourceCount] = useState(0);
  const [mcpPromptCount, setMcpPromptCount] = useState(0);
  const [subagentStates, setSubagentStates] = useState<SubagentProgress[]>([]);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const subagentDisplayNamesRef = useRef(new Map<string, string>());
  const toolInputsRef = useRef(new Map<string, Record<string, unknown>>());
  const turnCountRef = useRef(0);
  const [planContinueMsg, setPlanContinueMsg] = useState<string | null>(null);
  // Tracks how many times the plan auto-continue has resubmitted the same step
  // without it completing, so a step that can never finish cannot loop forever.
  const planContinueRef = useRef<{ stepId: number; attempts: number }>({ stepId: -1, attempts: 0 });
  // "Always" is a session decision, not a per-turn one; the loop's own
  // permission mode is rebuilt on every turn, so remember it out here.
  // Separate concern from plans — fixes the "always approve" choice not
  // persisting across turns within the same session.
  const sessionPermissionModeRef = useRef<AgavConfig["permissionMode"] | undefined>(undefined);
  const resetPlanContinue = () => { planContinueRef.current = { stepId: -1, attempts: 0 }; };
  const resumedRef = useRef(false);

  const confirmationQueueRef = useRef(new ConfirmationQueue());
  const conversationRef = useRef(new ConversationState());
  conversationRef.current.setModel(config.model);

  const refreshDisplay = useCallback(() => {
    // Erase the screen through Ink rather than writing RIS ourselves.
    // A hard reset drops the alternate screen buffer, mouse tracking and
    // bracketed paste, and Ink only arms those on mount — so the app fell back
    // to the terminal's native scrollback and lost its own wheel scrolling the
    // first time anything called refreshDisplay().
    resetDisplay();
    const displayMsgs = messagesToDisplay(conversationRef.current.getMessages());
    setMessages(displayMsgs);
    setTranscriptRevision((revision) => revision + 1);
  }, [resetDisplay]);

  // Rehydrate both the LLM conversation and visible transcript when resuming a saved session.
  useEffect(() => {
    if (resumeMessages && resumeMessages.length > 0 && !resumedRef.current) {
      resumedRef.current = true;
      conversationRef.current.setMessages(resumeMessages, resumeCompacted);
      const displayMsgs = messagesToDisplay(resumeMessages);
      if (displayMsgs.length > 0) {
        setMessages(displayMsgs);
        setError(null);
      }
    }
  }, []);
  const toolRegistryRef = useRef(createToolRegistry());
  const mcpManagerRef = useRef(new MCPManager());
  const abortRef = useRef<AbortController | null>(null);
  const submitPendingRef = useRef(false);
  const configRef = useRef(config);
  configRef.current = config;

  // Wire confirmation state to the UI and inject the subagent tool only when a provider exists.
  useEffect(() => {
    confirmationQueueRef.current.bind(setPendingConfirmation);

    if (provider) {
      const subagentTool = createSubagentTool({
        provider,
        parentToolRegistry: toolRegistryRef.current,
        getConfig: () => ({
          model: configRef.current.model,
          systemPrompt: configRef.current.systemPrompt ?? "",
          permissionMode: configRef.current.permissionMode,
          effort: configRef.current.effort,
          maxIterations: configRef.current.maxIterations,
        }),
        confirmationQueue: confirmationQueueRef.current,
        onProgressUpdate: setSubagentStates,
        onTokenUsage: (usage) => setTokenUsage((prev) => ({
          inputTokens: prev.inputTokens + usage.inputTokens,
          outputTokens: prev.outputTokens + usage.outputTokens,
          cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: prev.cacheWriteTokens + usage.cacheWriteTokens,
        })),
        getSignal: () => abortRef.current?.signal,
      });
      toolRegistryRef.current.register(subagentTool);
    }
  }, [provider]);

  // Re-pulls tools/resources/prompts from the manager and re-syncs the registries.
  const syncMcpState = useCallback(() => {
    const mcpTools = mcpManagerRef.current.getToolDefinitions();
    for (const tool of mcpTools) {
      toolRegistryRef.current.register(tool);
    }
    toolRegistryRef.current.register(mcpManagerRef.current.getResourceToolDefinition());

    const prompts = mcpManagerRef.current.getAllPrompts();
    setMcpPromptCommands(
      prompts.map((prompt) => createPromptCommand(prompt, mcpManagerRef.current)),
    );
    setMcpResourceCount(mcpManagerRef.current.getAllResources().length);
    setMcpPromptCount(prompts.length);
    setMcpServers(mcpManagerRef.current.getServerNames());
  }, []);

  // Load optional extension points once so plugin and MCP tools become available for later turns.
  useEffect(() => {
    mcpManagerRef.current.setOnChange(syncMcpState);

    (async () => {
      // Restore this session's plan. Resuming a session brings its own plan
      // back; a brand-new session starts on the draft slot, so any plan left
      // there by the previous unsaved session is discarded rather than shown.
      setPlanScope(sessionIdRef.current);
      await ensurePlanFile();
      if (!sessionIdRef.current) {
        await clearPlan();
      } else {
        const existing = await loadPlan();
        if (existing) {
          if (isPlanActive(existing)) {
            setActivePlan(existing);
          } else {
            await clearPlan();
          }
        }
      }
      prunePlans().catch(() => {});

      // Load plugins
      const pluginTools = await loadPlugins();
      setLoadedPlugins(pluginTools.map((tool) => tool.schema.name));
      for (const tool of pluginTools) {
        toolRegistryRef.current.register(tool);
      }

      // Load skills and register the activate_skill tool
      const skills = await loadSkills();
      if (skills.length > 0 && provider) {
        const skillConfirmCallback = (
          toolName: string,
          toolInput: Record<string, unknown>,
        ): Promise<ConfirmResult> => {
          return confirmationQueueRef.current.enqueue({
            toolName,
            input: toolInput,
          });
        };
        const skillTool = createSkillTool({
          provider,
          parentRegistry: toolRegistryRef.current,
          getConfig: () => ({
            model: configRef.current.model,
            systemPrompt: configRef.current.systemPrompt ?? "",
            permissionMode: configRef.current.permissionMode,
            effort: configRef.current.effort,
            maxIterations: configRef.current.maxIterations,
          }),
          confirmTool: skillConfirmCallback,
          onTokenUsage: (usage) => setTokenUsage((prev) => ({
            inputTokens: prev.inputTokens + usage.inputTokens,
            outputTokens: prev.outputTokens + usage.outputTokens,
            cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
            cacheWriteTokens: prev.cacheWriteTokens + usage.cacheWriteTokens,
          })),
          getSignal: () => abortRef.current?.signal,
        });
        toolRegistryRef.current.register(skillTool);
      }
      const userSkillCmds = skills
        .filter((s) => s.frontmatter.invocation !== "agav")
        .map((s) => createSkillSlashCommand(s));
      setSkillCommands(userSkillCmds);

      // Load agents — do NOT register as tools yet; registration happens lazily per-turn
      if (provider) {
        const { loadAgents, setCachedAgents } = await import("../agents/loader.js");
        const agents = await loadAgents();
        setCachedAgents(agents);
      }

      // Start MCP servers
      if (config.mcpServers) {
        for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
          // Skip non-server entries: schema metadata keys (description, eg, etc.)
          // and malformed values. A valid server config must have either `command`
          // (stdio) or `url` (remote) — anything else is not a real server entry.
          if (typeof serverConfig !== "object" || serverConfig === null
            || !("command" in serverConfig || "url" in serverConfig)) {
            continue;
          }
          try {
            await mcpManagerRef.current.startServer(name, serverConfig);
            syncMcpState();
          } catch (err) {
            process.stderr.write(`[mcp:${name}] failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      }
    })();

    return () => {
      mcpManagerRef.current.stopAll();
    };
  }, []);

  /** Abort the active loop and clear any queued confirmations waiting on user input. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    confirmationQueueRef.current.clear();
  }, []);

  const addDisplayMessage = useCallback((msg: DisplayMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  /** Reset visible chat state and the underlying conversation history for a fresh session. */
  const clearMessages = useCallback(() => {
    setMessages([]);
    conversationRef.current.clear();
    setError(null);
    sessionIdRef.current = null;
    setSessionId(undefined);
    sessionNameRef.current = undefined;
    setSessionName(undefined);
    sessionPermissionModeRef.current = undefined;
    resetPlanContinue();
    // Back to the draft slot, and drop whatever the last unsaved session left
    // there so the new session does not inherit a plan it never made.
    setPlanScope(null);
    setActivePlan(null);
    clearPlan().catch(() => {});
    setTranscriptRevision((revision) => revision + 1);
  }, []);

  /**
   * Re-read the plan for the current scope into the panel. Slash commands write
   * straight to disk, so without this the panel keeps rendering a plan the user
   * has already cleared or edited.
   */
  const refreshPlan = useCallback(() => {
    loadPlan()
      .then((plan) => setActivePlan(isPlanActive(plan) ? plan : null))
      .catch(() => {});
  }, []);

  /** Resolve the oldest pending tool confirmation with the user's decision. */
  const confirmTool = useCallback((choice: ConfirmResult) => {
    if (choice === "always") sessionPermissionModeRef.current = "auto-accept";
    // Reset the turn timer so it only counts active agent work, not time
    // spent waiting for the user to approve/deny a tool call.
    updateTurnStart(Date.now());
    confirmationQueueRef.current.resolve(choice);
  }, []);

  const addTokenUsage = useCallback((usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => {
    setTokenUsage((prev) => ({
      inputTokens: prev.inputTokens + usage.inputTokens,
      outputTokens: prev.outputTokens + usage.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: prev.cacheWriteTokens + usage.cacheWriteTokens,
    }));
  }, []);

  const saveNow = useCallback((extraUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => {
    setTokenUsage((currentUsage) => {
      const merged = extraUsage
        ? {
            inputTokens: currentUsage.inputTokens + extraUsage.inputTokens,
            outputTokens: currentUsage.outputTokens + extraUsage.outputTokens,
            cacheReadTokens: currentUsage.cacheReadTokens + extraUsage.cacheReadTokens,
            cacheWriteTokens: currentUsage.cacheWriteTokens + extraUsage.cacheWriteTokens,
          }
        : currentUsage;
      saveSession(
        conversationRef.current.getMessages(),
        config.model,
        config.provider,
        sessionIdRef.current ?? undefined,
        merged,
        conversationRef.current.wasCompacted,
        sessionNameRef.current,
      ).then((id) => {
        sessionIdRef.current = id;
        setSessionId(id);
        adoptPlanScope(id);
      }).catch(() => {});
      return merged;
    });
  }, [config.model, config.provider]);

  const loadSession = useCallback((session: SessionRecord) => {
    conversationRef.current.setMessages(session.messages, session.compacted);
    sessionIdRef.current = session.id;
    setSessionId(session.id);
    sessionNameRef.current = session.name;
    setSessionName(session.name);
    setTokenUsage(session.tokenUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    setError(null);
    // Show the plan belonging to the session being loaded — not whichever plan
    // happened to be on screen, and without deleting either one.
    resetPlanContinue();
    setActivePlan(null);
    setPlanScope(session.id);
    loadPlan()
      .then((plan) => setActivePlan(isPlanActive(plan) ? plan : null))
      .catch(() => {});
    refreshDisplay();
  }, [refreshDisplay]);

  const activateSession = useCallback((id: string, name?: string) => {
    sessionIdRef.current = id;
    setSessionId(id);
    sessionNameRef.current = name;
    setSessionName(name);
    setPlanScope(id);
    loadPlan()
      .then((plan) => setActivePlan(isPlanActive(plan) ? plan : null))
      .catch(() => {});
  }, []);

  const renameSession = useCallback((name: string) => {
    sessionNameRef.current = name;
    setSessionName(name);
    saveNow();
  }, [saveNow]);

  /** Start a new agent turn, wiring UI events to loop events and persisting results on completion. */
  const submit = useCallback(
    async (input: string, extraBlocks?: ContentBlock[], displayText?: string, followUpMessages?: DisplayMessage[], invocationReason?: InvocationReason): Promise<boolean> => {
      if (!provider) {
        setError("No LLM provider configured. Check your API key.");
        return false;
      }
      if (submitPendingRef.current) return false;

      const trimmed = input.trim();
      if (!trimmed) return false;
      submitPendingRef.current = true;

      let expansion;
      try {
        expansion = await expandFileMentions(trimmed, { cwd: process.cwd() });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        submitPendingRef.current = false;
        return false;
      }

      const submittedText = expansion.expanded.trim();
      const submittedBlocks = [...(extraBlocks ?? []), ...expansion.contentBlocks];
      const warningText = expansion.warnings.map((warning) => `⚠ ${warning}`).join("\n");
      const visibleText = [displayText ?? expansion.displayText, warningText].filter(Boolean).join("\n");

      setError(null);

      // Clear plan display when user sends a new message (not auto-continue).
      // If the plan is still active, turn_complete will reload it.
      if (!displayText) {
        setActivePlan(null);
        // A real message from the user is fresh input for the current step, so
        // the no-progress budget starts over.
        resetPlanContinue();
      }

      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", content: visibleText, sourceText: trimmed, invocationReason },
        ...(followUpMessages ?? []),
      ]);

      conversationRef.current.addUserMessage(submittedText, submittedBlocks, visibleText, trimmed, invocationReason);

      setIsLoading(true);
      updateTurnStart(Date.now());
      setLastTurnDurationMs(null);
      setStreamingText("");
      setToolCalls([]);

      const abortController = new AbortController();
      abortRef.current = abortController;

      const confirmToolCallback = (
        toolName: string,
        toolInput: Record<string, unknown>,
        diffPreview?: DiffLine[],
      ): Promise<ConfirmResult> => {
        return confirmationQueueRef.current.enqueue({
          toolName,
          input: toolInput,
          diffLines: diffPreview,
        });
      };

      (async () => {
        let currentText = "";
        let currentThinking = "";

        try {
          // Split per-turn context by how often it changes. Stable pieces (AGAV.md,
          // memories, skills, MCP resources) stay in the system prompt; volatile
          // pieces (git state, steers, agent catalog) are appended to this turn's
          // user message below. Anything volatile at the front of the request evicts
          // the tool schemas and the whole conversation from the provider's prefix cache.
          const { refreshStableContext, refreshVolatileContext, formatTurnContext } =
            await import("../utils/system-prompt.js");
          const [stableCtx, { context: volatileCtx }] = await Promise.all([
            refreshStableContext(mcpManagerRef.current),
            refreshVolatileContext(trimmed),
          ]);
          const effectiveSystemPrompt = stableCtx
            ? (config.systemPrompt ?? "") + "\n\n" + stableCtx
            : config.systemPrompt;

          const turnContextParts: string[] = [];
          if (volatileCtx) turnContextParts.push(volatileCtx);

          // Register enabled agents as callable tools. Registration is always-on
          // regardless of whether the catalog hint was included in the volatile context.
          if (provider) {
            const { getCachedAgents } = await import("../agents/loader.js");
            const { agentToTool } = await import("../agents/registry-factory.js");
            const agents = getCachedAgents();
            const enabledAgents = agents.filter((a) => a.manifest.enabled !== false);
            for (const agent of enabledAgents) {
              const toolName = `${agent.alias || agent.manifest.name}_agent`;
              if (!toolRegistryRef.current.getSchemas().find((s) => s.name === toolName)) {
                const { makeAgentProgressTracker } = await import("../agent/subagent-progress.js");
                const trackerCache = new Map<string, (event: import("../agent/loop.js").AgentEvent) => void>();
                toolRegistryRef.current.register(agentToTool(agent, {
                  provider,
                  config: configRef.current,
                  onProgressUpdate: (callId, event) => {
                    if (!trackerCache.has(callId)) {
                      trackerCache.set(callId, makeAgentProgressTracker(
                        callId,
                        agent.alias || agent.manifest.name,
                        agent.manifest.description || agent.manifest.name,
                        setSubagentStates,
                      ));
                    }
                    trackerCache.get(callId)!(event);
                  },
                  confirmTool: confirmToolCallback,
                }));
              }
            }
            // Unregister agent tools that are no longer enabled, using the
            // full set of known agent names to avoid accidentally removing
            // unrelated MCP tools that happen to end with "_agent".
            const allAgentToolNames = new Set(agents.map((a) => `${a.alias || a.manifest.name}_agent`));
            const enabledNames = new Set(enabledAgents.map((a) => `${a.alias || a.manifest.name}_agent`));
            for (const schema of toolRegistryRef.current.getSchemas()) {
              if (allAgentToolNames.has(schema.name) && !enabledNames.has(schema.name)) {
                toolRegistryRef.current.unregister(schema.name);
              }
            }
          }

          const existingPlan = await loadPlan();
          // A plan-worthy prompt at the start of a fresh conversation supersedes
          // whatever plan is on disk; anything else carries the existing one
          // forward. The superseded plan is only deleted once a replacement has
          // actually been saved, so a failed re-plan does not lose it.
          const supersedesPlan = shouldAutoPlan(trimmed) && conversationRef.current.length <= 1;
          const carriedPlan = !supersedesPlan && isPlanActive(existingPlan) ? existingPlan : null;

          if (shouldAutoPlan(trimmed) && !carriedPlan) {
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: "system", content: "Creating plan..." },
            ]);

            const planPrompt =
              "You are a planning assistant. Break the user's task into a small number of high-level steps (2-5 steps max). " +
              "Each step should represent a meaningful milestone, not a granular sub-task.\n\n" +
              "Guidelines:\n" +
              "- Prefer fewer, broader steps over many narrow ones.\n" +
              "- If the task is about writing documentation, a plan, or a report — the steps should be about researching and writing, NOT executing or verifying.\n" +
              "- Only include verifyCommand when there is a meaningful, safe command to confirm success (e.g. running tests, checking a file exists). Do NOT include commands that require installing software or running project-specific tooling that may not exist.\n" +
              "- The goal should be a concise one-line summary of what the user asked for.\n\n" +
              "Respond ONLY in this JSON format (no markdown, no explanation):\n" +
              '{"goal":"...","steps":[{"id":1,"title":"...","description":"...","verifyCommand":"..."}]}';

            let planJson = "";
            for await (const event of provider.stream({
              model: config.model,
              messages: [{ role: "user", content: [{ type: "text", text: trimmed }] }],
              systemPrompt: planPrompt,
              effort: config.effort,
              maxTokens: config.maxTokens,
              signal: abortController.signal,
            })) {
              if (event.type === "text_delta") planJson += event.text;
              if (event.type === "usage") {
                setTokenUsage((prev) => ({
                  inputTokens: prev.inputTokens + event.inputTokens,
                  outputTokens: prev.outputTokens + event.outputTokens,
                  cacheReadTokens: prev.cacheReadTokens + (event.cacheReadTokens ?? 0),
                  cacheWriteTokens: prev.cacheWriteTokens + (event.cacheWriteTokens ?? 0),
                }));
              }
            }

            try {
              // Extract JSON from response (might be wrapped in markdown)
              const jsonMatch = planJson.match(/\{[\s\S]*\}/);
              if (!jsonMatch) throw new Error("no JSON object in planning response");

              const parsed = JSON.parse(jsonMatch[0]);
              const plan: Plan = {
                goal: parsed.goal ?? trimmed,
                steps: (parsed.steps ?? []).map((s: any, i: number) => ({
                  id: s.id ?? i + 1,
                  title: String(s.title ?? ""),
                  description: String(s.description ?? ""),
                  status: "pending" as const,
                  verifyCommand: s.verifyCommand || undefined,
                })),
                createdAt: new Date().toISOString(),
                currentStep: 0,
              };
              // A stepless plan is indistinguishable from a finished one, so
              // treat it as a failed parse rather than saving it over a good plan.
              if (plan.steps.length === 0) throw new Error("planning response had no steps");

              await savePlan(plan);
              resetPlanContinue();
              setActivePlan(plan);

              setMessages((prev) => [
                ...prev,
                {
                  id: nextId(),
                  role: "system",
                  content: `Plan created: ${plan.goal} (${plan.steps.length} steps)`,
                },
              ]);

              turnContextParts.push(formatPlanForPrompt(plan));
            } catch {
              // Nothing was saved, so any superseded plan is still on disk.
              const kept = isPlanActive(existingPlan);
              if (kept) setActivePlan(existingPlan);
              setMessages((prev) => [
                ...prev,
                {
                  id: nextId(),
                  role: "system",
                  content: kept
                    ? "Plan creation failed — keeping the previous plan. Use /plan to view it."
                    : "Plan creation failed — proceeding without a plan.",
                },
              ]);
            }
          } else if (carriedPlan) {
            turnContextParts.push(formatPlanForPrompt(carriedPlan));
          }

          // Attach volatile context to the tail of this turn's user message. It is
          // left frozen in history rather than rewritten on later turns: editing an
          // earlier message would invalidate the very prefix this split protects,
          // so the wrapper tells the model to trust the most recent copy.
          if (turnContextParts.length > 0) {
            conversationRef.current.appendToLastUserMessage(
              formatTurnContext(turnContextParts.join("\n\n")),
            );
          }

          const loop = runAgentLoop({
            provider,
            conversation: conversationRef.current,
            toolRegistry: toolRegistryRef.current,
            model: config.model,
            systemPrompt: effectiveSystemPrompt,
            effort: config.effort,
            maxTokens: config.maxTokens,
            maxIterations: config.maxIterations,
            signal: abortController.signal,
            confirmTool: confirmToolCallback,
            permissionMode: sessionPermissionModeRef.current ?? config.permissionMode,
            allowedTools: config.allowedTools,
            hooks: config.hooks,
            // Only the main conversation's loop drains mid-turn /steer
            // directives — subagent/skill/agent loops must not consume them.
            drainSteers,
          });

          for await (const event of loop) {
            switch (event.type) {
              case "thinking":
                currentThinking += event.text;
                setThinkingText(currentThinking);
                break;

              case "streaming_text":
                currentText += event.text;
                setStreamingText(currentText);
                break;

              case "compacted":
                setMessages((prev) => [
                  ...prev,
                  {
                    id: nextId(),
                    role: "system",
                    content: `\x1b[2mAuto-compacted: ${event.droppedCount} messages summarized (Ctrl+O to see full summary)\x1b[0m`,
                  },
                ]);
                break;

              case "tool_call_start":
                setToolCalls((prev) => [
                  ...prev,
                  {
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    input: {},
                    argsJson: "",
                    status: "running",
                  },
                ]);
                break;

              case "tool_call_input_delta":
                setToolCalls((prev) =>
                  prev.map((tc) => {
                    if (tc.toolCallId !== event.toolCallId) return tc;
                    const json = (tc.argsJson ?? "") + event.argsJson;
                    let parsed = tc.input;
                    try {
                      parsed = JSON.parse(json);
                      if (tc.toolName === "subagent" && parsed.title && tc.toolCallId) {
                        subagentDisplayNamesRef.current.set(tc.toolCallId, String(parsed.title));
                      }
                      if (tc.toolCallId) {
                        toolInputsRef.current.set(tc.toolCallId, parsed);
                      }
                    } catch {}
                    return { ...tc, argsJson: json, input: parsed };
                  }),
                );
                break;

              case "tool_confirmation_request":
                // The loop is paused — it's awaiting confirmToolCallback
                break;

              case "tool_result": {
                if (event.toolName === "update_plan") {
                  loadPlan().then((plan) => {
                    if (plan) setActivePlan(plan);
                  }).catch(() => {});
                }
                const resultToolCallId = event.toolCallId;
                const resultToolName = event.toolName;
                const resultIsError = event.isError;
                const resultOutput = event.output;
                const resultDiffLines = event.diffLines;
                const resolvedInput = resultToolCallId ? toolInputsRef.current.get(resultToolCallId) : undefined;
                setToolCalls((prev) => {
                  let matched = false;
                  return prev.map((tc) => {
                    if (matched) return tc;
                    const isMatch = resultToolCallId
                      ? tc.toolCallId === resultToolCallId
                      : tc.toolName === resultToolName && tc.status === "running";
                    if (isMatch) {
                      matched = true;
                      return { ...tc, status: resultIsError ? "error" as const : "done" as const, result: resultOutput };
                    }
                    return tc;
                  });
                });
                setMessages((prev) => [
                  ...prev,
                  {
                    id: nextId(),
                    role: "tool",
                    content: resultOutput,
                    toolName: resultToolName,
                    toolDisplayName: resultToolName === "subagent"
                      ? subagentDisplayNamesRef.current.get(resultToolCallId ?? "") ?? undefined
                      : undefined,
                    toolInput: resolvedInput,
                    isError: resultIsError,
                    diffLines: resultDiffLines,
                  },
                ]);
                break;
              }

              case "assistant_message_complete": {
                const completedText = event.text;
                if (completedText) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: nextId(),
                      role: "assistant",
                      content: completedText,
                    },
                  ]);
                }
                currentText = "";
                currentThinking = "";
                setStreamingText("");
                setThinkingText("");
                setToolCalls([]);
                break;
              }

              case "usage":
                setTokenUsage((prev) => ({
                  inputTokens: prev.inputTokens + event.inputTokens,
                  outputTokens: prev.outputTokens + event.outputTokens,
                  cacheReadTokens: prev.cacheReadTokens + (event.cacheReadTokens ?? 0),
                  cacheWriteTokens: prev.cacheWriteTokens + (event.cacheWriteTokens ?? 0),
                }));
                break;

              case "turn_complete":
                setIsLoading(false);
                finalizeTurnTimer();
                setSubagentStates([]);
                setTokenUsage((currentUsage) => {
                  saveSession(
                    conversationRef.current.getMessages(),
                    config.model,
                    config.provider,
                    sessionIdRef.current ?? undefined,
                    currentUsage,
                    conversationRef.current.wasCompacted,
                    sessionNameRef.current,
                  ).then((id) => {
                    sessionIdRef.current = id;
                    setSessionId(id);
                    // Re-key the plan the moment this session gets an identity,
                    // so it is still findable after the session ends.
                    adoptPlanScope(id);
                  }).catch(() => {});
                  return currentUsage;
                });
                saveSessionState(
                  conversationRef.current.getMessages(),
                  config.model,
                  config.provider,
                  false,
                ).catch(() => {});
                turnCountRef.current++;
                maybeRunBackgroundImprovement(turnCountRef.current, getCachedSkills(), (msg) => {
                  setMessages((prev) => [...prev, { id: nextId(), role: "system", content: msg }]);
                }).catch(() => {});

                // Auto-continue if the active plan has pending steps
                loadPlan().then(async (latestPlan) => {
                  if (!latestPlan) return;
                  const pendingSteps = latestPlan.steps.filter((s) => s.status === "pending" || s.status === "in_progress");
                  if (pendingSteps.length === 0) {
                    // Plan is complete — clear display and delete the file
                    resetPlanContinue();
                    setActivePlan(null);
                    await clearPlan().catch(() => {});
                    return;
                  }

                  const next = pendingSteps[0]!;
                  // A step only leaves the pending list once the model marks it
                  // done or failed. If it never can — the user declined the tool
                  // it needs, say — resubmitting it forever re-asks for the same
                  // confirmation on every turn. Give up after a few tries.
                  const tracker = planContinueRef.current;
                  tracker.attempts = tracker.stepId === next.id ? tracker.attempts + 1 : 1;
                  tracker.stepId = next.id;

                  if (tracker.attempts > MAX_PLAN_STEP_ATTEMPTS) {
                    next.status = "failed";
                    latestPlan.currentStep = latestPlan.steps.findIndex(
                      (s) => s.status === "pending" || s.status === "in_progress",
                    );
                    await savePlan(latestPlan).catch(() => {});
                    resetPlanContinue();
                    setActivePlan(latestPlan);
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: nextId(),
                        role: "system",
                        content: `Plan paused: step ${next.id} ("${next.title}") made no progress after ${MAX_PLAN_STEP_ATTEMPTS} attempts and has been marked failed. Send a message to carry on, or use /plan clear to drop the plan.`,
                      },
                    ]);
                    return;
                  }

                  setActivePlan(latestPlan);
                  setPlanContinueMsg(`Do Step ${next.id} only: ${next.title}. Mark it in_progress, do the work, mark it done, then end your response silently — no commentary about stopping or pausing.`);
                }).catch(() => {});
                break;

              case "steer_applied": {
                const count = event.directives.length;
                setMessages((prev) => [
                  ...prev,
                  {
                    id: nextId(),
                    role: "system",
                    content: `\x1b[2mDelivered ${count} steer${count === 1 ? "" : "s"} to the running agent.\x1b[0m`,
                  },
                ]);
                break;
              }

              case "error": {
                const errorMsg = event.error.message || "Unknown error";
                setMessages((prev) => [
                  ...prev,
                  {
                    id: nextId(),
                    role: "system",
                    content: `Error: ${errorMsg}`,
                    isError: true,
                  },
                ]);
                setIsLoading(false);
                finalizeTurnTimer();
                break;
              }
            }
          }
          // Tool-only turns (no text response) are normal during plan execution
          // and agentic loops — no safeguard message needed.
        } catch (err) {
          if (abortController.signal.aborted) {
            const partialText = currentText;
            if (partialText) {
              setMessages((prev) => [
                ...prev,
                {
                  id: nextId(),
                  role: "assistant",
                  content: partialText + "\n\n*(cancelled)*",
                },
              ]);
            }
          } else {
            const errMsg = err instanceof Error ? err.message : String(err);
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: "system",
                content: `Error: ${errMsg || "Unknown error"}`,
                isError: true,
              },
            ]);
          }
          setIsLoading(false);
          finalizeTurnTimer();
        }

        setStreamingText("");
        setToolCalls([]);
        setPendingConfirmation(null);
        abortRef.current = null;
        submitPendingRef.current = false;
      })();
      return true;
    },
    [provider, config, isLoading, activePlan],
  );

  useEffect(() => {
    if (!isLoading && planContinueMsg) {
      const msg = planContinueMsg;
      const stepMatch = msg.match(/Step (\d+) only: (.+?)\./);
      const displayText = stepMatch ? `▸ Plan step ${stepMatch[1]}` : "▸ Continuing plan...";
      setPlanContinueMsg(null);
      setTimeout(() => submit(msg, undefined, displayText), 100);
    }
  }, [isLoading, planContinueMsg, submit]);

  return {
    messages,
    streamingText,
    thinkingText,
    isLoading,
    toolCalls,
    error,
    pendingConfirmation,
    tokenUsage,
    loadedPlugins,
    mcpServers,
    mcpPromptCommands,
    skillCommands,
    mcpResourceCount,
    mcpPromptCount,
    subagentStates,
    activePlan,
    refreshPlan,
    submit,
    addDisplayMessage,
    cancel,
    clearMessages,
    confirmTool,
    conversation: conversationRef.current,
    toolRegistry: toolRegistryRef.current,
    saveNow,
    refreshDisplay,
    addTokenUsage,
    loadSession,
    activateSession,
    renameSession,
    sessionId,
    sessionName,
    transcriptRevision,
    turnStartTime,
    lastTurnDurationMs,
  };
}
