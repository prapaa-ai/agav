import type { ToolDefinition, ToolResult } from "./types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolRegistry } from "./registry.js";
import type { ConfirmationQueue } from "../agent/confirmation-queue.js";
import type { SubagentProgress } from "../agent/subagent-types.js";
import type { EffortLevel, PermissionMode } from "../config/config.js";
import type { ToolCallInfo } from "../components/tool-call-display.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import { ToolRegistry as ToolRegistryClass } from "./registry.js";
import { createWorktree, removeWorktree, applyWorktreeChanges } from "../utils/worktree.js";
import { formatSteersForPrompt } from "../commands/steer.js";

const MAX_CONCURRENT = 5;
export interface SubagentToolDeps {
  provider: LLMProvider;
  parentToolRegistry: ToolRegistry;
  getConfig: () => {
    model: string;
    systemPrompt: string;
    permissionMode: PermissionMode;
    effort: EffortLevel;
    maxIterations: number;
  };
  confirmationQueue: ConfirmationQueue;
  onProgressUpdate: (subagents: SubagentProgress[]) => void;
  onTokenUsage: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  getSignal: () => AbortSignal | undefined;
}

/** Build the subagent tool, including progress tracking and optional isolated worktrees. */
export function createSubagentTool(deps: SubagentToolDeps): ToolDefinition {
  let counter = 0;
  const active = new Map<string, SubagentProgress>();

  /** Push the latest active subagent snapshot to the UI layer. */
  function broadcast(): void {
    deps.onProgressUpdate(Array.from(active.values()));
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

      const childRegistry = new ToolRegistryClass();
      for (const tool of deps.parentToolRegistry.list()) {
        if (tool.schema.name !== "subagent") {
          childRegistry.register(tool);
        }
      }

      const conversation = new ConversationState();
      conversation.setModel(config.model);
      conversation.addUserMessage(task);

      const steers = formatSteersForPrompt();
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
        status: "running",
        toolCalls: [],
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

      try {
        if (useWorktree) {
          worktreePath = await createWorktree(id);
          if (worktreePath) {
            process.chdir(worktreePath);
          }
        }

        const signal = deps.getSignal();

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
          provider: deps.provider,
          conversation,
          toolRegistry: childRegistry,
          model: config.model,
          systemPrompt: subagentSystemPrompt,
          signal,
          confirmTool,
          permissionMode: config.permissionMode,
          effort: config.effort,
          maxIterations: config.maxIterations,
        });

        let currentToolCalls: ToolCallInfo[] = [];

        for await (const event of loop) {
          if (signal?.aborted) break;

          switch (event.type) {
            case "streaming_text":
              progress.streamingText += event.text;
              broadcast();
              break;

            case "tool_call_start":
              progress.totalToolCalls++;
              currentToolCalls = [
                ...currentToolCalls,
                { toolName: event.toolName, input: {}, status: "running" },
              ];
              progress.toolCalls = currentToolCalls;
              broadcast();
              break;

            case "tool_result": {
              currentToolCalls = currentToolCalls.map((tc) =>
                tc.toolName === event.toolName && tc.status === "running"
                  ? { ...tc, status: event.isError ? "error" : "done" }
                  : tc,
              );
              progress.toolCalls = currentToolCalls;
              broadcast();
              break;
            }

            case "assistant_message_complete":
              finalText = event.text;
              progress.streamingText = "";
              currentToolCalls = [];
              progress.toolCalls = currentToolCalls;
              broadcast();
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
              broadcast();
              if (worktreePath) {
                process.chdir(originalCwd);
                await removeWorktree(worktreePath, branchName).catch(() => {});
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
          const { applied, error: mergeErr } = await applyWorktreeChanges(worktreePath);
          if (!applied) {
            mergeNote = `\n\n[Worktree merge warning]: ${mergeErr}`;
          }
          await removeWorktree(worktreePath, branchName).catch(() => {});
        }

        progress.status = "done";
        progress.result = finalText;
        progress.streamingText = "";
        active.set(id, { ...progress });
        broadcast();

        setTimeout(() => {
          active.delete(id);
          broadcast();
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
        broadcast();

        if (worktreePath) {
          process.chdir(originalCwd);
          await removeWorktree(worktreePath, branchName).catch(() => {});
        }

        setTimeout(() => {
          active.delete(id);
          broadcast();
        }, 100);

        return { output: `Subagent error: ${errMsg}`, isError: true };
      }
    },
  };
}
