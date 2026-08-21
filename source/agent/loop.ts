import type {
  LLMProvider,
  StreamEvent,
  ContentBlock,
  Message,
} from "../providers/types.js";
import type { ConversationState } from "./conversation.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  MAX_STEPS_PROMPT,
  NEEDS_VERIFY_PROMPT,
  VERIFY_FAILED_PROMPT,
  testsFailedPrompt,
} from "./internal-prompts.js";

export type AgentEvent =
  | { type: "planning"; plan: string }
  | { type: "thinking"; text: string }
  | { type: "streaming_text"; text: string }
  | { type: "compacted"; droppedCount: number }
  | { type: "tool_call_start"; toolName: string; toolCallId: string }
  | { type: "tool_call_input_delta"; toolCallId: string; argsJson: string }
  | { type: "tool_confirmation_request"; toolName: string; toolCallId: string; input: Record<string, unknown>; diffLines?: import("../utils/diff.js").DiffLine[] }
  | { type: "tool_result"; toolName: string; toolCallId?: string; output: string; isError: boolean; diffLines?: import("../utils/diff.js").DiffLine[] }
  | { type: "assistant_message_complete"; text: string }
  | { type: "turn_complete" }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: "error"; error: Error };

import type { DiffLine } from "../utils/diff.js";
import { computeEditDiff, computeDiff } from "../utils/diff.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ConfirmResult = "yes" | "no" | "always";

export type ConfirmToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  diffLines?: DiffLine[],
) => Promise<ConfirmResult>;

import type { PermissionMode } from "../config/config.js";
import { runHook, getHookForTool } from "./hooks.js";
import { isDestructiveCommand } from "../utils/sandbox.js";

interface LoopParams {
  provider: LLMProvider;
  conversation: ConversationState;
  toolRegistry: ToolRegistry;
  model: string;
  systemPrompt?: string;
  effort?: import("../config/config.js").EffortLevel;
  maxTokens?: number;
  signal?: AbortSignal;
  confirmTool?: ConfirmToolFn;
  permissionMode?: PermissionMode;
  maxIterations?: number;
  allowedTools?: string[];
  hooks?: import("../config/config.js").AgavHooks;
}

// Tools that never need confirmation because they cannot modify the working
// tree or reach outside the session. `save_memory` and `update_plan` write only
// to Agav's own state — the plan is in-memory scratch space the model rewrites
// constantly, so prompting for it would make every turn unusable.
const SAFE_TOOLS = new Set(["read_file", "grep_search", "find_files", "list_directory", "web_search", "lsp_query", "read_notebook", "fetch_url", "overview", "activate_skill", "save_memory", "update_plan"]);

function isAllowed(
  toolName: string,
  input: Record<string, unknown>,
  allowedTools?: string[],
  /**
   * When set, a bare `run_command` rule no longer matches — only a rule that
   * names the input, such as `run_command:rm -rf build/*`. Used so a blanket
   * grant cannot quietly authorise a destructive command.
   */
  options: { requirePattern?: boolean } = {},
): boolean {
  if (!allowedTools || allowedTools.length === 0) return false;

  const primaryInput =
    toolName === "run_command" ? String(input.command ?? "")
    : toolName === "edit_file" || toolName === "write_file" || toolName === "read_file"
      ? String(input.path ?? "")
      : "";

  for (const rule of allowedTools) {
    if (!rule.includes(":")) {
      if (!options.requirePattern && rule === toolName) return true;
      continue;
    }
    const colonIdx = rule.indexOf(":");
    const ruleToolName = rule.slice(0, colonIdx);
    const pattern = rule.slice(colonIdx + 1);
    if (ruleToolName !== toolName) continue;
    if (matchGlob(pattern, primaryInput)) return true;
  }
  return false;
}

/** Convert a simple glob rule into a regex so allowlist path checks stay lightweight. */
function matchGlob(pattern: string, text: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(text);
}

export async function* runAgentLoop(
  params: LoopParams,
): AsyncGenerator<AgentEvent> {
  const { provider, conversation, toolRegistry, model, systemPrompt, effort, maxTokens, signal, confirmTool } = params;
  let permissionMode = params.permissionMode ?? "ask";
  let testRepairAttempts = 0;
  const MAX_REPAIR_ATTEMPTS = 3;
  let madeEdits = false;
  let ranShellAfterEdit = false;
  let lastShellFailed = false;
  let verifyReprompts = 0;
  const MAX_VERIFY_REPROMPTS = 2;
  const maxIterations = params.maxIterations ?? 100;
  // Calls the user has already refused, keyed by name + arguments. Scoped to
  // the full loop invocation (not per-turn) so the model cannot retry a denied
  // call later in the same session. This is intentionally conservative: if the
  // user changes their mind, they can say so in a new message and the submit()
  // call starts a fresh loop with an empty set.
  const deniedCalls = new Set<string>();

  let pendingSummarizeUsage: Record<string, number> | null = null;

  const summarize = async (msgs: Message[]): Promise<string> => {
    let result = "";
    pendingSummarizeUsage = null;
    try {
      for await (const event of provider.stream({
        model,
        messages: msgs,
        systemPrompt:
          "Summarize this conversation concisely. Structure your summary as:\n\n" +
          "## Task\nWhat the user asked for (1 sentence)\n\n" +
          "## Changes Made\n- File paths modified and what was changed\n\n" +
          "## Key Findings\n- Bugs found, errors encountered, important observations\n\n" +
          "## Current State\n- What has been completed vs what remains\n- Last approach tried and whether it worked\n\n" +
          "Be brief but preserve ALL file paths, function names, and specific error messages. " +
          "This summary replaces earlier messages — anything not included here is lost.",
        effort,
        maxTokens: 2048,
      })) {
        if (event.type === "text_delta") result += event.text;
        if (event.type === "usage") {
          pendingSummarizeUsage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens ?? 0,
            cacheWriteTokens: event.cacheWriteTokens ?? 0,
          };
        }
      }
    } catch {
      return "";
    }
    return result || "";
  };

  // Ask the provider for the window it will actually enforce before the first
  // compaction check runs. Providers cache this, so it costs at most one probe
  // per model; a failure just leaves the name-based estimate in place.
  if (provider.getContextWindow) {
    try {
      conversation.setContextWindow(await provider.getContextWindow(model));
    } catch {
      // Non-fatal — fall back to the name-based limits.
    }
  }

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Auto-compact if conversation is getting long
    const { compacted, droppedCount } = await conversation.compactIfNeeded(false, summarize);
    if (compacted) {
      yield { type: "compacted", droppedCount };
      if (pendingSummarizeUsage) {
        yield { type: "usage", inputTokens: pendingSummarizeUsage["inputTokens"]!, outputTokens: pendingSummarizeUsage["outputTokens"]!, cacheReadTokens: pendingSummarizeUsage["cacheReadTokens"], cacheWriteTokens: pendingSummarizeUsage["cacheWriteTokens"] };
        pendingSummarizeUsage = null;
      }
    }

    // Graceful shutdown: on the last step, ask for a summary instead of hard-erroring
    const isLastStep = iteration === maxIterations - 1;
    if (isLastStep) {
      conversation.addInternalUserMessage(MAX_STEPS_PROMPT);
    }

    let textAccum = "";
    const toolCalls = new Map<
      string,
      { name: string; argsJson: string; providerMetadata?: Record<string, unknown> }
    >();
    let stopReason = "";

    try {
      for await (const event of provider.stream({
        model,
        messages: conversation.getMessages(),
        tools: toolRegistry.getSchemas(),
        systemPrompt,
        effort,
        maxTokens,
        signal,
      })) {
        if (signal?.aborted) {
          yield { type: "error", error: new Error("Aborted") };
          return;
        }

        switch (event.type) {
          case "text_delta":
            textAccum += event.text;
            yield { type: "streaming_text", text: event.text };
            break;

          case "thinking_delta":
            yield { type: "thinking", text: event.text };
            break;

          case "tool_call_start":
            toolCalls.set(event.toolCallId, {
              name: event.toolName,
              argsJson: "",
            });
            yield {
              type: "tool_call_start",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
            };
            break;

          case "tool_call_delta": {
            const call = toolCalls.get(event.toolCallId);
            if (call) {
              call.argsJson += event.argsJson;
              if (event.providerMetadata) {
                call.providerMetadata = { ...call.providerMetadata, ...event.providerMetadata };
              }
              if (event.argsJson) {
                yield {
                  type: "tool_call_input_delta",
                  toolCallId: event.toolCallId,
                  argsJson: event.argsJson,
                };
              }
            }
            break;
          }

          case "usage":
            yield { type: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens };
            break;

          case "message_end":
            stopReason = event.stopReason;
            break;

          case "error":
            yield { type: "error", error: event.error };
            return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/context.*(length|window|limit|overflow)|too many tokens|maximum.*token/i.test(msg)) {
        const { compacted: recovered, droppedCount: recoveredCount } = await conversation.compactIfNeeded(true, summarize);
        if (recovered) {
          yield { type: "compacted", droppedCount: recoveredCount };
          if (pendingSummarizeUsage) {
            yield { type: "usage", inputTokens: pendingSummarizeUsage["inputTokens"]!, outputTokens: pendingSummarizeUsage["outputTokens"]!, cacheReadTokens: pendingSummarizeUsage["cacheReadTokens"], cacheWriteTokens: pendingSummarizeUsage["cacheWriteTokens"] };
            pendingSummarizeUsage = null;
          }
          continue;
        }
      }
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
      return;
    }

    // Build assistant message content blocks
    const assistantContent: ContentBlock[] = [];
    if (textAccum) {
      assistantContent.push({ type: "text", text: textAccum });
    }
    for (const [id, call] of toolCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.argsJson);
      } catch {
        input = { raw: call.argsJson };
      }
      assistantContent.push({
        type: "tool_use",
        toolCallId: id,
        toolName: call.name,
        toolInput: input,
        ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
      });
    }
    conversation.addAssistantMessage(assistantContent);

    // No tool calls — final response (unless edits are unverified or verification failed)
    if (toolCalls.size === 0) {
      const needsVerify = madeEdits && !ranShellAfterEdit;
      const verifyFailed = madeEdits && ranShellAfterEdit && lastShellFailed;
      if ((needsVerify || verifyFailed) && verifyReprompts < MAX_VERIFY_REPROMPTS) {
        verifyReprompts++;
        conversation.addInternalUserMessage(needsVerify ? NEEDS_VERIFY_PROMPT : VERIFY_FAILED_PROMPT);
        continue;
      }
      yield { type: "assistant_message_complete", text: textAccum };
      yield { type: "turn_complete" };
      return;
    }

    // Execute tools and collect results
    yield { type: "assistant_message_complete", text: textAccum };

    // Phase 1: resolve permissions (sequential — needs user input)
    const approved = new Map<string, { input: Record<string, unknown> }>();
    const toolResults: ContentBlock[] = [];

    for (const [id, call] of toolCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.argsJson);
      } catch {
        input = { raw: call.argsJson };
      }

      // Hard block: if an explicit allowlist is set, reject tools not on it
      if (params.allowedTools && params.allowedTools.length > 0
        && !SAFE_TOOLS.has(call.name)
        && !isAllowed(call.name, input, params.allowedTools)) {
        toolResults.push({ type: "tool_result", toolCallId: id, toolResult: `Tool '${call.name}' is not permitted in this mode.`, isError: true });
        yield { type: "tool_result", toolName: call.name, output: `Tool '${call.name}' is not permitted in this mode.`, isError: true };
        continue;
      }

      const tool = params.toolRegistry.list().find((t) => t.schema.name === call.name);
      const toolDestructiveFlag = tool?.schema.destructive;

      // Only trust destructive:false from builtin tools (SAFE_TOOLS).
      // Non-builtin tools (agents, MCP) cannot lower their own destructive status.
      let isDestructive: boolean;
      if (toolDestructiveFlag === true) {
        isDestructive = true;
      } else if (toolDestructiveFlag === false && SAFE_TOOLS.has(call.name)) {
        isDestructive = false;
      } else {
        isDestructive = call.name === "run_command" && isDestructiveCommand(String(input.command ?? ""));
      }

      const destructiveApproved = isDestructive
        && isAllowed(call.name, input, params.allowedTools, { requirePattern: true });
      const denyWrites = permissionMode === "deny-writes";
      const trustedSafe = toolDestructiveFlag === false && SAFE_TOOLS.has(call.name);
      const needsConfirm = (isDestructive && !destructiveApproved)
        || (!SAFE_TOOLS.has(call.name)
          && !trustedSafe
          && permissionMode !== "auto-accept"
          && !isAllowed(call.name, input, params.allowedTools));
      if ((denyWrites && isDestructive) || (needsConfirm && (denyWrites || !confirmTool))) {
        const reason = denyWrites
          ? "Write operations are denied (--deny-writes mode)."
          : `Tool '${call.name}' requires confirmation but no confirmation handler is available (headless mode).`;
        toolResults.push({ type: "tool_result", toolCallId: id, toolResult: reason, isError: true });
        yield { type: "tool_result", toolName: call.name, output: reason, isError: true };
        continue;
      }
      const denialKey = `${call.name}:${JSON.stringify(input)}`;
      if (needsConfirm && deniedCalls.has(denialKey)) {
        const reason = `User already denied '${call.name}' with these exact arguments. Do not request it again — take a different approach, or stop and explain what you need.`;
        toolResults.push({ type: "tool_result", toolCallId: id, toolResult: reason, isError: true });
        yield { type: "tool_result", toolName: call.name, toolCallId: id, output: reason, isError: true };
        continue;
      }
      if (needsConfirm && confirmTool) {
        // Compute diff preview for file-modifying tools
        let previewDiff: DiffLine[] | undefined;
        try {
          if (call.name === "edit_file" && input.path && input.old_string && input.new_string) {
            const content = await readFile(resolve(String(input.path)), "utf-8");
            previewDiff = computeEditDiff(content, String(input.old_string), String(input.new_string));
          } else if (call.name === "write_file" && input.path && input.content) {
            try {
              const oldContent = await readFile(resolve(String(input.path)), "utf-8");
              previewDiff = computeDiff(oldContent, String(input.content));
            } catch {
              // New file — no diff preview
            }
          }
        } catch {}

        yield { type: "tool_confirmation_request", toolName: call.name, toolCallId: id, input, diffLines: previewDiff };
        const choice = await confirmTool(call.name, input, previewDiff);
        if (choice === "always") {
          permissionMode = "auto-accept";
        }
        if (choice === "no") {
          deniedCalls.add(denialKey);
          const reason = "User denied this tool call. Do not retry it with the same arguments — take a different approach, or stop and explain what you need.";
          toolResults.push({ type: "tool_result", toolCallId: id, toolResult: reason, isError: true });
          yield { type: "tool_result", toolName: call.name, toolCallId: id, output: reason, isError: true };
          continue;
        }
      }
      approved.set(id, { input });
    }

    // Phase 2: execute approved tools in parallel
    let hasTestRun = false;
    let hasTestFailure = false;
    if (approved.size > 0) {
      const entries = [...approved.entries()].map(([id, { input }]) => {
        const call = toolCalls.get(id)!;
        return { id, name: call.name, input };
      });

      const execResults = await Promise.all(
        entries.map(async (entry) => {
          const result = await toolRegistry.execute(entry.name, entry.input);
          return { ...entry, result };
        }),
      );

      for (const { id, name, input, result } of execResults) {
        if (name === "run_tests") {
          hasTestRun = true;
          if (result.isError) hasTestFailure = true;
        }
        if (name === "edit_file" || name === "write_file") {
          madeEdits = true;
          ranShellAfterEdit = false;
          lastShellFailed = false;
        }
        if (name === "run_command" && madeEdits) {
          ranShellAfterEdit = true;
          lastShellFailed = result.isError;
        }
        const hookDef = getHookForTool(name, input, params.hooks);
        if (hookDef && !result.isError) {
          const hookOutput = await runHook(hookDef.hook, hookDef.vars);
          if (hookOutput) {
            result.output += `\n\n[Hook output]: ${hookOutput}`;
          }
        }
        yield { type: "tool_result", toolName: name, toolCallId: id, output: result.output, isError: result.isError, diffLines: result.diffLines };
        toolResults.push({
          type: "tool_result",
          toolCallId: id,
          toolResult: result.output,
          toolResultContent: result.contentBlocks,
          isError: result.isError,
        });
      }
    }

    conversation.addToolResults(toolResults);

    if (hasTestFailure) {
      testRepairAttempts++;
      if (testRepairAttempts <= MAX_REPAIR_ATTEMPTS) {
        conversation.addInternalUserMessage(testsFailedPrompt(testRepairAttempts, MAX_REPAIR_ATTEMPTS));
      }
    } else if (hasTestRun) {
      testRepairAttempts = 0;
    }
  }

  yield {
    type: "assistant_message_complete",
    text: "[Agent reached maximum iterations]",
  };
  yield { type: "turn_complete" };
}
