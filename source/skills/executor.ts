import { runInSandbox } from "../utils/sandbox.js";
import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES, truncateToolText } from "../utils/tool-output.js";
import type { SkillDefinition } from "./types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolRegistry as ToolRegistryClass } from "../tools/registry.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import type { AgentEvent, ConfirmResult } from "../agent/loop.js";
import type { PermissionMode, EffortLevel } from "../config/config.js";
import { recordSkillTrace } from "./improvement.js";
import { formatSteersForPrompt } from "../commands/steer.js";
import { baseToolName } from "./skill-utils.js";
import { createBuiltinToolRegistry, OPTIONAL_TOOL_NAMES } from "../tools/registry-factory.js";

interface SkillExecDeps {
  provider: LLMProvider;
  parentRegistry: ToolRegistry;
  model: string;
  systemPrompt: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  iterationsBudget: { remaining: number, total: number };
  confirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
  // Reports usage deltas as they arrive. The returned tokenUsage is the total;
  // callers using this callback must not add that total again.
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  signal?: AbortSignal;
  contextMessages?: import("../providers/types.js").Message[];
  onEvent?: (event: AgentEvent) => void;
}

function buildSkillRegistry(parent: ToolRegistry, skill: SkillDefinition): ToolRegistry {
  const child = new ToolRegistryClass();
  const allowedList = skill.frontmatter["allowed-tools"];
  const allowed = allowedList ? new Set(allowedList.map(baseToolName)) : undefined;
  const disallowed = new Set((skill.frontmatter["disallowed-tools"] ?? []).map(baseToolName));

  for (const tool of parent.list()) {
    if (tool.schema.name === "subagent" || tool.schema.name === "activate_skill") continue;
    if (disallowed.has(tool.schema.name)) continue;
    if (allowed && !allowed.has(tool.schema.name)) continue;
    child.register(tool);
  }
  // Only explicitly listed optional built-ins can be added beyond the parent set.
  // Preserve parent overrides and let disallowed-tools take precedence.
  if (allowed) {
    const optional = [...allowed].filter((name) => OPTIONAL_TOOL_NAMES.has(name) && !disallowed.has(name));
    for (const tool of createBuiltinToolRegistry(optional).list()) {
      if (!parent.list().some((entry) => entry.schema.name === tool.schema.name)) child.register(tool);
    }
  }
  return child;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Aborted");
}

interface ShellBlockOpts {
  signal?: AbortSignal;
  permissionMode: PermissionMode;
  confirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
}

async function processShellBlocks(text: string, opts: ShellBlockOpts): Promise<string> {
  const shellBlockRegex = /```sh\n([\s\S]*?)```/g;
  const blocks: { match: string; command: string }[] = [];
  let m;
  while ((m = shellBlockRegex.exec(text)) !== null) {
    blocks.push({ match: m[0], command: m[1]!.trim() });
  }
  if (blocks.length === 0) return text;

  // Local copy so "always" escalation does not leak back into the caller's deps.
  let mode = opts.permissionMode;
  let result = text;
  // Replace exactly one occurrence starting from a specific position.
  // String.replace with a string argument always takes the first match,
  // which fails silently when the same shell block appears twice.
  const replaceOnce = (haystack: string, needle: string, replacement: string): string => {
    const idx = haystack.indexOf(needle);
    if (idx < 0) return haystack;
    return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
  };
  for (const block of blocks) {
    checkAborted(opts.signal);
    // deny-writes: never execute shell blocks.
    if (mode === "deny-writes") {
      result = replaceOnce(result, block.match, "[shell block skipped — write operations denied]");
      continue;
    }

    // ask: require explicit confirmation for each block.
    if (mode === "ask") {
      if (!opts.confirmTool) {
        result = replaceOnce(result, block.match, "[shell block skipped — no confirmation handler available]");
        continue;
      }
      const choice = await opts.confirmTool("skill_shell_block", { command: block.command });
      checkAborted(opts.signal);
      if (choice === "no") {
        result = replaceOnce(result, block.match, "[shell block skipped — denied by user]");
        continue;
      }
      if (choice === "always") {
        mode = "auto-accept";
      }
    }

    // auto-accept (or confirmed): execute.
    checkAborted(opts.signal);
    // Reuse process-tree ownership so abort also stops pipeline descendants.
    // Skill instructions are not a user sandbox opt-out; use the shell default.
    const output = await runInSandbox({
      command: block.command, cwd: process.cwd(), timeout: 10_000,
      maxBuffer: 1024 * 1024, signal: opts.signal,
    });
    checkAborted(opts.signal);
    if (output.error) {
      const stderr = output.stderr.trim();
      if (!stderr) throw output.error;
      // Do not echo command text or persist potentially sensitive diagnostics.
      let message = `Skill shell block failed (${output.backend}): ${output.error.message}\n\nstderr:\n${stderr}`;
      if (Buffer.byteLength(message) > MAX_TOOL_OUTPUT_BYTES || message.split("\n").length > MAX_TOOL_OUTPUT_LINES) {
        message = truncateToolText(message, "[Shell diagnostics truncated; omitted content is unavailable.]");
      }
      throw new Error(message, { cause: output.error });
    }
    result = replaceOnce(result, block.match, output.stdout.trim());
  }
  return result;
}

function processDynamicContext(body: string, args: string): string {
  return body.replace(/\$ARGUMENTS|\$CWD/g, placeholder =>
    placeholder === "$ARGUMENTS" ? args || "(no arguments)" : process.cwd());
}

export interface SkillExecResult {
  output: string;
  tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export async function executeSkill(
  skill: SkillDefinition,
  args: string,
  deps: SkillExecDeps,
): Promise<SkillExecResult> {
  if (!deps.iterationsBudget) {
    throw new Error("iterationsBudget is required");
  }
  let result = "";
  let failed = false;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  // Preprocessing can prompt or execute commands, so it belongs to the same
  // failure/progress lifecycle as the child loop.
  try {
    checkAborted(deps.signal);
    let prompt = processDynamicContext(skill.body, args);
    prompt = await processShellBlocks(prompt, {
      permissionMode: deps.permissionMode,
      confirmTool: deps.confirmTool,
      signal: deps.signal,
    });
    checkAborted(deps.signal);

    const registry = buildSkillRegistry(deps.parentRegistry, skill);
    const conversation = new ConversationState();
    const model = skill.frontmatter.model ?? deps.model;
    conversation.setModel(model);
    // Compaction mutates blocks, so the child must own a deep context snapshot.
    if (deps.contextMessages) conversation.setMessages(structuredClone(deps.contextMessages));

    // Shell preprocessing can consume an embedded argument; retain the request
    // unless the original template embedded it and the final prompt still has it.
    const argumentsEmbedded = skill.body.includes("$ARGUMENTS") && prompt.includes(args);
    const userMessage = args && !argumentsEmbedded
      ? `${prompt}\n\nUser request: ${args}`
      : prompt;
    conversation.addUserMessage(userMessage);

    const steers = formatSteersForPrompt();
    const skillSystemPrompt = deps.systemPrompt +
      `\n\nYou are executing the "${skill.name}" skill. ${skill.description}. ` +
      "Focus exclusively on the skill's task. Be thorough but concise." +
      (steers ? "\n\n" + steers : "");

    const loop = runAgentLoop({
      provider: deps.provider,
      conversation,
      toolRegistry: registry,
      model,
      systemPrompt: skillSystemPrompt,
      effort: skill.frontmatter.effort ?? deps.effort,
      maxTokens: 16384,
      signal: deps.signal,
      confirmTool: deps.confirmTool,
      permissionMode: deps.permissionMode,
      iterationsBudget: deps.iterationsBudget,
    });

    // Account for each usage event immediately, including tokens spent before
    // an abort or provider error. Keep the aggregate only for the result/trace.
    for await (const event of loop) {
      deps.onEvent?.(event);
      switch (event.type) {
        case "streaming_text":
          result += event.text;
          break;
        case "assistant_message_complete":
          result = event.text;
          break;
        case "usage":
          usage.inputTokens += event.inputTokens;
          usage.outputTokens += event.outputTokens;
          usage.cacheReadTokens += event.cacheReadTokens ?? 0;
          usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
          deps.onTokenUsage?.({
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens ?? 0,
            cacheWriteTokens: event.cacheWriteTokens ?? 0,
          });
          break;
        case "error":
          failed = true;
          throw event.error;
      }
    }
  } catch (err) {
    // Emitted errors were already forwarded; thrown errors still need to
    // terminate the progress entry.
    if (!failed) deps.onEvent?.({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
    failed = true;
    throw err;
  } finally {
    recordSkillTrace(skill.name, args, usage.inputTokens + usage.outputTokens, !failed).catch(() => {});
  }

  return {
    output: result || "(skill produced no output)",
    tokenUsage: usage,
  };
}
