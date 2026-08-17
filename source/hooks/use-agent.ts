import { useState, useCallback, useRef, useEffect } from "react";
import type { DisplayMessage } from "../components/message-list.js";
import type { ToolCallInfo } from "../components/tool-call-display.js";
import type { LLMProvider, ContentBlock } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import { createToolRegistry } from "../tools/registry-factory.js";
import type { ToolRegistry } from "../tools/registry.js";
import { saveSession, type SessionRecord } from "../config/history.js";
import { saveSessionState } from "../config/session-state.js";
import {
  shouldAutoPlan,
  savePlan,
  loadPlan,
  clearPlan,
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

let messageId = 0;
/** Generate incremental display ids so transient UI rows have stable React keys. */
function nextId(): string {
  return String(++messageId);
}

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
  submit: (input: string, extraBlocks?: ContentBlock[], displayText?: string, followUpMessages?: DisplayMessage[]) => Promise<boolean>;
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
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
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
  const resumedRef = useRef(false);

  const confirmationQueueRef = useRef(new ConfirmationQueue());
  const conversationRef = useRef(new ConversationState());
  conversationRef.current.setModel(config.model);

  function messagesToDisplay(msgs: import("../providers/types.js").Message[]): DisplayMessage[] {
    const displayMsgs: DisplayMessage[] = [];
    for (const msg of msgs) {
      if (msg.displayText) {
        displayMsgs.push({
          id: nextId(),
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.displayText,
          sourceText: msg.sourceText,
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

  const refreshDisplay = useCallback(() => {
    process.stdout.write("\x1Bc");
    const displayMsgs = messagesToDisplay(conversationRef.current.getMessages());
    setMessages(displayMsgs);
    setTranscriptRevision((revision) => revision + 1);
  }, []);

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
      // Clear stale/completed plans; only show active plans on resume
      if (resumeMessages && resumeMessages.length > 0) {
        await ensurePlanFile();
        const existing = await loadPlan();
        if (existing) {
          const allDone = existing.steps.every((s) => s.status === "done" || s.status === "failed");
          if (allDone) {
            await clearPlan();
          } else {
            setActivePlan(existing);
          }
        }
      } else {
        await clearPlan();
      }

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
          try {
            await mcpManagerRef.current.startServer(name, serverConfig);
            syncMcpState();
          } catch {
            // MCP server failed to start — non-fatal
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
    setTranscriptRevision((revision) => revision + 1);
  }, []);

  /** Resolve the oldest pending tool confirmation with the user's decision. */
  const confirmTool = useCallback((choice: ConfirmResult) => {
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
      ).then((id) => { sessionIdRef.current = id; setSessionId(id); }).catch(() => {});
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
    setActivePlan(null);
    clearPlan().catch(() => {});
    refreshDisplay();
  }, [refreshDisplay]);

  const activateSession = useCallback((id: string, name?: string) => {
    sessionIdRef.current = id;
    setSessionId(id);
    sessionNameRef.current = name;
    setSessionName(name);
  }, []);

  const renameSession = useCallback((name: string) => {
    sessionNameRef.current = name;
    setSessionName(name);
    saveNow();
  }, [saveNow]);

  /** Start a new agent turn, wiring UI events to loop events and persisting results on completion. */
  const submit = useCallback(
    async (input: string, extraBlocks?: ContentBlock[], displayText?: string, followUpMessages?: DisplayMessage[]): Promise<boolean> => {
      if (!provider) {
        setError("No LLM provider configured. Check your API key.");
        return false;
      }
      if (isLoading || submitPendingRef.current) return false;

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
      }

      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", content: visibleText, sourceText: trimmed },
        ...(followUpMessages ?? []),
      ]);

      conversationRef.current.addUserMessage(submittedText, submittedBlocks, visibleText, trimmed);

      setIsLoading(true);
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
          // Refresh dynamic context (git state, AGAV.md, agent catalog) before each turn.
          // Pass the user message so the agent catalog is only injected when relevant.
          const { refreshDynamicContext } = await import("../utils/system-prompt.js");
          const { context: dynamicCtx, includeAgentTools } = await refreshDynamicContext(
            mcpManagerRef.current,
            trimmed
          );
          let effectiveSystemPrompt = dynamicCtx
            ? (config.systemPrompt ?? "") + "\n\n" + dynamicCtx
            : config.systemPrompt;

          // Tool registration: always register enabled agents so they are callable
          // regardless of whether the catalog was included in the system prompt.
          // Lazy catalog injection (via includeAgentTools) only controls the hint text
          // in the system prompt — it must not gate whether tools are actually available.
          if (provider) {
            const { getCachedAgents } = await import("../agents/loader.js");
            const { agentToTool } = await import("../agents/registry-factory.js");
            const agents = getCachedAgents();
            const enabledAgents = agents.filter((a) => a.manifest.enabled !== false);
            for (const agent of enabledAgents) {
              const toolName = `${agent.alias || agent.manifest.name}_agent`;
              if (!toolRegistryRef.current.getSchemas().find((s) => s.name === toolName)) {
                const { makeAgentProgressTracker } = await import("../agent/subagent-progress.js");
                // Cache one tracker per callId so seed() runs exactly once per invocation,
                // not once per event (which caused duplicate subagentStates entries).
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
            // Remove tools for agents that were disabled since last turn
            const enabledNames = new Set(enabledAgents.map((a) => `${a.alias || a.manifest.name}_agent`));
            for (const schema of toolRegistryRef.current.getSchemas()) {
              if (schema.name.endsWith("_agent") && !enabledNames.has(schema.name)) {
                toolRegistryRef.current.unregister(schema.name);
              }
            }
          }

          const existingPlan = await loadPlan();
          const hasActivePlan = existingPlan && existingPlan.steps.some((s) => s.status !== "done");

          // Clear stale plan if user is asking for something completely different
          if (hasActivePlan && shouldAutoPlan(trimmed) && conversationRef.current.length <= 1) {
            const { clearPlan } = await import("../agent/planner.js");
            await clearPlan();
          }

          const planAfterClear = await loadPlan();
          const stillHasPlan = planAfterClear && planAfterClear.steps.some((s) => s.status !== "done");

          if (shouldAutoPlan(trimmed) && !stillHasPlan) {
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
              if (jsonMatch) {
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

                await savePlan(plan);
                setActivePlan(plan);
                const planText = formatPlanForPrompt(plan);

                setMessages((prev) => [
                  ...prev,
                  {
                    id: nextId(),
                    role: "system",
                    content: `Plan created: ${plan.goal} (${plan.steps.length} steps)`,
                  },
                ]);

                effectiveSystemPrompt = (config.systemPrompt ?? "") + "\n\n" + planText;
              }
            } catch {
              setMessages((prev) => [
                ...prev,
                { id: nextId(), role: "system", content: "Plan creation failed — proceeding without a plan." },
              ]);
            }
          } else {
            // Inject active plan if one exists
            if (stillHasPlan && planAfterClear) {
              effectiveSystemPrompt = (config.systemPrompt ?? "") + "\n\n" + formatPlanForPrompt(planAfterClear);
            }
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
            permissionMode: config.permissionMode,
            allowedTools: config.allowedTools,
            hooks: config.hooks,
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
                  ).then((id) => { sessionIdRef.current = id; setSessionId(id); }).catch(() => {});
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
                loadPlan().then((latestPlan) => {
                  if (!latestPlan) return;
                  const pendingSteps = latestPlan.steps.filter((s) => s.status === "pending" || s.status === "in_progress");
                  if (pendingSteps.length > 0) {
                    setActivePlan(latestPlan);
                    const next = pendingSteps[0]!;
                    setPlanContinueMsg(`Do Step ${next.id} only: ${next.title}. Mark it in_progress, do the work, mark it done, then end your response silently — no commentary about stopping or pausing.`);
                  } else {
                    // Plan is complete — clear display and delete the file
                    setActivePlan(null);
                    import("../agent/planner.js").then((m) => m.clearPlan()).catch(() => {});
                  }
                }).catch(() => {});
                break;

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
  };
}
