import { createHash } from "node:crypto";
import type { ToolDefinition, ToolResult } from "./types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolRegistry } from "./registry.js";
import type { ConfirmationQueue } from "../agent/confirmation-queue.js";
import type { SubagentProgress } from "../agent/subagent-types.js";
import type { AgavConfig, EffortLevel, PermissionMode } from "../config/config.js";
import { fetchAvailableModels, findMatchingModels } from "../commands/model.js";
import type { FetchedModel } from "../commands/model.js";
import { isProviderName, orgPolicyError } from "../config/startup.js";
import { createProvider } from "../providers/registry.js";
import type { ToolCallInfo } from "../components/tool-call-display.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import { ToolRegistry as ToolRegistryClass } from "./registry.js";
import { createWorktree, removeWorktree, applyWorktreeChanges } from "../utils/worktree.js";
import { createSteerQueue, formatSteersForPrompt } from "../commands/steer.js";

const MAX_CONCURRENT = 5;
export interface SubagentToolDeps {
  provider: LLMProvider;
  parentToolRegistry: ToolRegistry;
  getConfig: () => {
    model: string;
    systemPrompt: string;
    permissionMode: PermissionMode;
    effort: EffortLevel;
    iterationsBudget: { remaining: number, total: number };
    /** Org-managed permission floor; child "Always" cannot widen past it. */
    orgPermissionFloor?: PermissionMode;
  };
  getProviderConfig?: () => AgavConfig;
  confirmationQueue: ConfirmationQueue;
  onProgressUpdate: (subagents: SubagentProgress[]) => void;
  onSteerApplied?: (id: string, title: string, directives: string[]) => void;
  onTokenUsage: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  getSignal: () => AbortSignal | undefined;
}

/** Build the subagent tool, including progress tracking and optional isolated worktrees. */
export function createSubagentTool(deps: SubagentToolDeps): ToolDefinition & { cancelSubagent: (id: string) => void } {
  let counter = 0;
  const active = new Map<string, SubagentProgress>();
  const controllers = new Map<string, AbortController>();
  let modelCatalogCache: { key: string; models: Promise<FetchedModel[]> } | undefined;

  // Throttle UI updates to ~15 fps so concurrent subagents don't flood
  // React with state updates on every streaming_text delta.
  let broadcastDirty = false;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  const BROADCAST_INTERVAL_MS = 66; // ~15 fps

  /** Push the latest active subagent snapshot to the UI layer. */
  function broadcast(): void {
    broadcastDirty = true;
    if (broadcastTimer !== null) return; // flush is already scheduled
    broadcastTimer = setTimeout(flushBroadcast, BROADCAST_INTERVAL_MS);
  }

  /** Flush immediately — for terminal events that must appear right away. */
  function broadcastNow(): void {
    if (broadcastTimer !== null) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    broadcastDirty = false;
    deps.onProgressUpdate(Array.from(active.values()));
  }

  function flushBroadcast(): void {
    broadcastTimer = null;
    if (broadcastDirty) {
      broadcastDirty = false;
      deps.onProgressUpdate(Array.from(active.values()));
    }
  }

  return {
    schema: {
      name: "subagent",
      description:
        "Spawn an independent subagent to handle a self-contained task. " +
        "The subagent runs its own agent loop with access to all tools (files, shell, search, etc.) " +
        "but has its own conversation context. Use this when a task can be decomposed into independent pieces " +
        "that can run in parallel. Provide all necessary context in the task description — the subagent cannot " +
        "ask follow-up questions. Returns the subagent's final response.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "A short, action-oriented label describing what this subagent does (e.g. 'Analyzing dependencies', 'Fixing auth validation', 'Writing unit tests'). Shown to the user as a progress indicator.",
          },
          task: {
            type: "string",
            description:
              "A clear, self-contained description of what the subagent should accomplish. " +
              "Include file paths, function names, and any context needed.",
          },
          model: {
            type: "string",
            description: "Only set this when the user explicitly requested a different model. Omit to use the active model. The requested model must exist."
          },
        },
        required: ["title", "task"],
      },
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const title = String(input.title ?? "Subagent");
      const task = String(input.task ?? "");
      if (!task) {
        return { output: "No task provided.", isError: true };
      }

      if (active.size >= MAX_CONCURRENT) {
        return {
          output: `Maximum concurrent subagents (${MAX_CONCURRENT}) reached. Wait for existing subagents to complete.`,
          isError: true,
        };
      }

      const id = `sa-${++counter}`;
      const config = deps.getConfig();
      const requestedModel = typeof input.model === "string" && input.model.trim()
        ? input.model.trim()
        : config.model;
      let childProvider = deps.provider;
      let childModel = config.model;
      let contextWindow: number | undefined;

      if (requestedModel !== config.model) {
        const providerConfig = deps.getProviderConfig?.();
        if (!providerConfig) {
          return { output: "Cannot select a different subagent model: provider configuration is unavailable.", isError: true };
        }
        // Config is read per call in use-agent; only reuse a catalog while the
        // provider settings which affect its contents remain unchanged.
        const catalogConfig = JSON.stringify({
          anthropicApiKey: providerConfig.anthropicApiKey,
          openaiApiKey: providerConfig.openaiApiKey,
          openrouterApiKey: providerConfig.openrouterApiKey,
          nvidiaApiKey: providerConfig.nvidiaApiKey,
          deepseekApiKey: providerConfig.deepseekApiKey,
          geminiApiKey: providerConfig.geminiApiKey,
          vertexAICredentialsPath: providerConfig.vertexAICredentialsPath,
          vertexAILocation: providerConfig.vertexAILocation,
          ollamaEndpoint: providerConfig.ollamaEndpoint,
          ollamaHost: providerConfig.ollamaHost,
          ollamaPort: providerConfig.ollamaPort,
        });
        const catalogKey = createHash("sha256").update(catalogConfig).digest("hex");
        if (modelCatalogCache?.key !== catalogKey) {
          const models = fetchAvailableModels(providerConfig).then(({ models }) => models);
          modelCatalogCache = { key: catalogKey, models };
          void models.catch(() => {
            if (modelCatalogCache?.models === models) modelCatalogCache = undefined;
          });
        }
        const models = await modelCatalogCache.models;
        const matches = findMatchingModels(models, requestedModel);
        const selectedModel = matches.find((candidate) => candidate.provider === providerConfig.provider)
          ?? matches.find((candidate) => candidate.id === requestedModel)
          ?? (matches.length === 1 ? matches[0] : undefined);
        if (!selectedModel) {
          return { output: `Model '${requestedModel}' does not exist or is not available${matches.length > 1 ? " unambiguously" : ""}.`, isError: true };
        }
        if (!isProviderName(selectedModel.provider)) {
          return { output: `Model '${requestedModel}' has an unsupported provider and cannot be initialized.`, isError: true };
        }

        // A subagent inherits the parent's org policy: a requested model/provider
        // must satisfy any managed pin or allowlist, so it cannot route inference
        // around the policy through a different model on a cached/new provider.
        const childPolicyError = orgPolicyError({
          ...providerConfig,
          provider: selectedModel.provider,
          model: selectedModel.id,
        });
        if (childPolicyError) {
          return { output: `Subagent cannot use that model: ${childPolicyError}`, isError: true };
        }

        const approval = await deps.confirmationQueue.enqueue({
          toolName: "subagent_model",
          input: { title, model: requestedModel, activeModel: config.model },
          subagentTask: title,
          explicitApprovalOnly: true,
        }, deps.getSignal());
        if (approval !== "yes") {
          return { output: `Subagent model change to '${requestedModel}' was not approved.`, isError: true };
        }

        try {
          childProvider = createProvider({
            ...providerConfig,
            provider: selectedModel.provider,
            model: selectedModel.id,
          });
          childModel = selectedModel.id;
          contextWindow = selectedModel.contextWindow;
        } catch (error) {
          return {
            output: `Model '${requestedModel}' exists but could not be initialized: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      }

      const childRegistry = new ToolRegistryClass();
      for (const tool of deps.parentToolRegistry.list()) {
        if (tool.schema.name !== "subagent") {
          childRegistry.register(tool);
        }
      }

      const conversation = new ConversationState();
      conversation.setModel(childModel);
      conversation.setContextWindow(contextWindow);
      conversation.addUserMessage(task);

      const steers = formatSteersForPrompt();
      const steerQueue = createSteerQueue();
      const subagentSystemPrompt = [
        config.systemPrompt,
        "",
        "You are a subagent working on a specific task. Complete it thoroughly and report your results. " +
        "Do not ask questions — work with the information provided. Be concise in your final response.",
        steers ? "\n" + steers : "",
      ]
        .filter(Boolean)
        .join("\n");

      const progress: SubagentProgress = {
        id,
        title,
        task,
        model: childModel,
        status: "running",
        toolCalls: [],
        thinkingText: "",
        streamingText: "",
        startedAt: Date.now(),
        totalToolCalls: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      };
      active.set(id, progress);
      broadcast();

      const WRITE_KEYWORDS = /\b(fix|edit|write|refactor|implement|create|add|update|modify|change|delete|remove|rename)\b/i;
      const useWorktree = WRITE_KEYWORDS.test(task);
      let worktreePath: string | null = null;
      const branchName = `agav-sa-${id}`;
      const originalCwd = process.cwd();

      let finalText = "";

      // Create the child controller before any async work so cancellation is
      // possible during worktree setup, not only once streaming starts.
      const signal = deps.getSignal();
      const childController = new AbortController();
      controllers.set(id, childController);
      if (signal && !signal.aborted) {
        signal.addEventListener("abort", () => childController.abort(), { once: true });
      } else if (signal?.aborted) {
        childController.abort();
      }

      try {
        if (useWorktree) {
          worktreePath = await createWorktree(id);
          if (worktreePath) {
            process.chdir(worktreePath);
          }
        }

        // If cancelled during worktree setup, bail out before starting the loop.
        if (childController.signal.aborted) {
          if (worktreePath) {
            process.chdir(originalCwd);
            await removeWorktree(worktreePath, branchName).catch(() => { });
          }
          progress.status = "error";
          progress.error = "Cancelled";
          active.set(id, { ...progress });
          controllers.delete(id);
          broadcastNow();
          return { output: "Subagent cancelled.", isError: true };
        }

        const confirmTool = (
          toolName: string,
          toolInput: Record<string, unknown>,
          diffLines?: import("../utils/diff.js").DiffLine[],
        ) => {
          return deps.confirmationQueue.enqueue({
            toolName,
            input: toolInput,
            diffLines,
            subagentId: id,
            subagentTask: task.length > 60 ? task.slice(0, 60) + "..." : task,
          });
        };

        const loop = runAgentLoop({
          provider: childProvider,
          conversation,
          toolRegistry: childRegistry,
          model: childModel,
          systemPrompt: subagentSystemPrompt,
          signal: childController.signal,
          confirmTool,
          permissionMode: config.permissionMode,
          permissionFloor: config.orgPermissionFloor,
          effort: config.effort,
          iterationsBudget: config.iterationsBudget,
          drainSteers: steerQueue.drain,
        });

        const MAX_RECENT_ACTIONS = 10;

        let startNewReasoningSummary = true;

        const updateToolCall = (
          toolCallId: string | undefined,
          toolName: string,
          update: (toolCall: ToolCallInfo) => ToolCallInfo,
        ) => {
          const matchingIndex = toolCallId
            ? progress.toolCalls.findIndex((toolCall) => toolCall.toolCallId === toolCallId)
            : progress.toolCalls.map((toolCall, index) => ({ toolCall, index })).reverse()
              .find(({ toolCall }) => toolCall.toolName === toolName && toolCall.status === "running")?.index ?? -1;

          if (matchingIndex < 0) return;
          progress.toolCalls = progress.toolCalls.map((toolCall, index) =>
            index === matchingIndex ? update(toolCall) : toolCall,
          );
        };

        for await (const event of loop) {
          if (childController.signal.aborted) break;

          switch (event.type) {
            case "thinking":
              progress.thinkingText = (startNewReasoningSummary ? event.text : progress.thinkingText + event.text).slice(-2_000);
              startNewReasoningSummary = false;
              broadcast();
              break;

            case "streaming_text":
              progress.streamingText += event.text;
              broadcast();
              break;

            case "tool_call_start":
              progress.totalToolCalls++;
              progress.toolCalls = [
                ...progress.toolCalls,
                { toolName: event.toolName, toolCallId: event.toolCallId, input: {}, argsJson: "", status: "running" as const },
              ].slice(-MAX_RECENT_ACTIONS);
              broadcast();
              break;

            case "tool_call_input_delta":
              updateToolCall(event.toolCallId, "", (toolCall) => {
                const argsJson = (toolCall.argsJson ?? "") + event.argsJson;
                try {
                  return { ...toolCall, argsJson, input: JSON.parse(argsJson) };
                } catch {
                  return { ...toolCall, argsJson };
                }
              });
              broadcast();
              break;

            case "tool_result": {
              updateToolCall(event.toolCallId, event.toolName, (toolCall) => ({
                ...toolCall,
                status: event.isError ? "error" : "done",
                result: event.output,
                diffLines: event.diffLines,
              }));
              broadcast();
              break;
            }

            case "assistant_message_complete":
              finalText = event.text;
              progress.streamingText = "";
              startNewReasoningSummary = true;
              broadcastNow();
              break;

            case "steer_applied":
              deps.onSteerApplied?.(id, title, event.directives);
              break;

            case "turn_complete":
              steerQueue.dispose();
              break;

            case "usage":
              progress.tokenUsage.inputTokens += event.inputTokens;
              progress.tokenUsage.outputTokens += event.outputTokens;
              progress.tokenUsage.cacheReadTokens += event.cacheReadTokens ?? 0;
              deps.onTokenUsage({
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheReadTokens: event.cacheReadTokens ?? 0,
                cacheWriteTokens: event.cacheWriteTokens ?? 0,
              });
              break;

            case "error":
              progress.status = "error";
              progress.error = event.error.message;
              active.set(id, { ...progress });
              controllers.delete(id);
              broadcastNow();
              if (worktreePath) {
                process.chdir(originalCwd);
                await removeWorktree(worktreePath, branchName).catch(() => { });
              }
              return {
                output: `Subagent error: ${event.error.message}`,
                isError: true,
              };
          }
        }

        let mergeNote = "";
        if (worktreePath) {
          process.chdir(originalCwd);
          // Never merge partial edits from a cancelled subagent — discard the
          // worktree so incomplete, unreviewed changes cannot reach the parent.
          if (!childController.signal.aborted) {
            const { applied, error: mergeErr } = await applyWorktreeChanges(worktreePath);
            if (!applied) {
              mergeNote = `\n\n[Worktree merge warning]: ${mergeErr}`;
            }
          }
          await removeWorktree(worktreePath, branchName).catch(() => { });
        }

        if (childController.signal.aborted) {
          progress.status = "error";
          progress.error = "Cancelled";
          active.set(id, { ...progress });
          controllers.delete(id);
          broadcastNow();
          setTimeout(() => { active.delete(id); broadcastNow(); }, 100);
          return { output: "Subagent cancelled.", isError: true };
        }

        progress.status = "done";
        progress.result = finalText;
        progress.streamingText = "";
        active.set(id, { ...progress });
        controllers.delete(id);
        broadcastNow();

        setTimeout(() => {
          active.delete(id);
          broadcastNow();
        }, 100);

        return {
          output: (finalText || "Subagent completed but produced no output.") + mergeNote,
          isError: false,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        progress.status = "error";
        progress.error = errMsg;
        active.set(id, { ...progress });
        controllers.delete(id);
        broadcastNow();

        if (worktreePath) {
          process.chdir(originalCwd);
          await removeWorktree(worktreePath, branchName).catch(() => { });
        }

        setTimeout(() => {
          active.delete(id);
          broadcastNow();
        }, 100);

        return { output: `Subagent error: ${errMsg}`, isError: true };
      } finally {
        steerQueue.dispose();
      }
    },

    cancelSubagent(id: string) {
      const controller = controllers.get(id);
      if (controller) {
        controller.abort();
      }
      // Unblock any confirmation the subagent is waiting on so its loop can exit.
      deps.confirmationQueue.rejectBySubagentId(id);
    },
  };
}
