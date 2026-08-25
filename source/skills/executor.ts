import { execFile } from "node:child_process";
import type { SkillDefinition } from "./types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolRegistry as ToolRegistryClass } from "../tools/registry.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import type { ConfirmResult } from "../agent/loop.js";
import type { PermissionMode, EffortLevel } from "../config/config.js";
import { recordSkillTrace } from "./improvement.js";
import { formatSteersForPrompt } from "../commands/steer.js";

interface SkillExecDeps {
  provider: LLMProvider;
  parentRegistry: ToolRegistry;
  model: string;
  systemPrompt: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  maxIterations: number;
  confirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
  // Optional nested-skill accounting callback: /skill-name continues to use _tokenUsage on the
  // returned command result, while activate_skill uses this to merge usage into the parent turn.
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  signal?: AbortSignal;
}

/**
 * agentskills.io lets an entry narrow a tool to particular invocations —
 * `Bash(git:*)`. agav gates whole tools, so match on the name before the
 * qualifier; `Bash(git:*)` and `Bash` both name the same tool here.
 */
function baseToolName(entry: string): string {
  const paren = entry.indexOf("(");
  return (paren < 0 ? entry : entry.slice(0, paren)).trim();
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
  return child;
}

function processShellBlocks(text: string): Promise<string> {
  const shellBlockRegex = /```sh\n([\s\S]*?)```/g;
  const blocks: { match: string; command: string }[] = [];
  let m;
  while ((m = shellBlockRegex.exec(text)) !== null) {
    blocks.push({ match: m[0], command: m[1]!.trim() });
  }
  if (blocks.length === 0) return Promise.resolve(text);

  return blocks.reduce<Promise<string>>(async (textPromise, block) => {
    let result = await textPromise;
    const output = await new Promise<string>((resolve) => {
      execFile("/bin/sh", ["-c", block.command], { timeout: 10_000 }, (_err, stdout) => {
        resolve((stdout ?? "").trim());
      });
    });
    result = result.replace(block.match, output);
    return result;
  }, Promise.resolve(text));
}

function processDynamicContext(body: string, args: string): string {
  return body
    .replace(/\$ARGUMENTS/g, args || "(no arguments)")
    .replace(/\$CWD/g, process.cwd());
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
  let prompt = processDynamicContext(skill.body, args);
  prompt = await processShellBlocks(prompt);

  const registry = buildSkillRegistry(deps.parentRegistry, skill);
  const conversation = new ConversationState();
  conversation.setModel(deps.model);

  const userMessage = args
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
    model: skill.frontmatter.model ?? deps.model,
    systemPrompt: skillSystemPrompt,
    effort: skill.frontmatter.effort ?? deps.effort,
    maxTokens: 16384,
    signal: deps.signal,
    confirmTool: deps.confirmTool,
    permissionMode: deps.permissionMode,
    maxIterations: deps.maxIterations,
  });

  let result = "";
  let failed = false;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  // Report usage and record the trace from a finally so an abort or provider
  // error part-way through still accounts for the tokens already spent.
  try {
    for await (const event of loop) {
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
          break;
      }
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    deps.onTokenUsage?.(usage);
    recordSkillTrace(skill.name, args, usage.inputTokens + usage.outputTokens, !failed).catch(() => {});
  }

  return {
    output: result || "(skill produced no output)",
    tokenUsage: usage,
  };
}
