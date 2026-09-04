import React from "react";
import { render } from "./ink/index.js";
import App from "./app.js";
import { isEffortLevel, loadConfig, type AgavConfig } from "./config/config.js";
import { createProvider } from "./providers/registry.js";
import type { LLMProvider } from "./providers/types.js";
import { fetchAvailableModels, findMatchingModels, type FetchedModel } from "./commands/model.js";
import { buildSystemPrompt } from "./utils/system-prompt.js";
import { expandFileMentions } from "./utils/file-mentions.js";
import { loadSessionState, markCleanExit, markCleanExitSync } from "./config/session-state.js";
import { loadTheme } from "./config/theme.js";
import { ConversationState } from "./agent/conversation.js";
import { runAgentLoop } from "./agent/loop.js";
import { NO_EDITS_PROMPT, schemaRetryPrompt } from "./agent/internal-prompts.js";
import { createToolRegistry } from "./tools/registry-factory.js";
import { getToolLabel } from "./utils/tool-labels.js";
import { loadKeybindings } from "./config/keybindings.js";
import { dim, icons } from "./utils/color.js";
import { stopAllA2AAgents } from "./agents/a2a-client.js";
import {
  createOutputValidator,
  formatValidationErrors,
  loadOutputSchema,
  validateOutput,
  type OutputSchema,
} from "./utils/output-schema.js";
import {
  defaultModelForProvider,
  isProviderName,
  noProviderCredentialsError,
  providerConfigurationError,
  resolveStartupSelection,
  selectConfiguredProvider,
  type ProviderName,
} from "./config/startup.js";

const KNOWN_FLAGS = [
  "--help", "-h", "--version", "-v", "--provider", "-p", "--model", "-m",
  "--effort", "--auto-accept", "-y", "--stream", "--output-schema", "--deny-writes",
  "--resume", "-r", "--ollama-host", "--ollama-port", "--ollama-endpoint",
  "--ollama-api-key", "--print", "-P", "--permission", "--openai-api", "--max-turns",
  "--trace",
];

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] !== b[j - 1] ? 1 : 0),
      );
  return dp[m]![n]!;
}

function findClosestFlag(input: string): string | undefined {
  let best: string | undefined;
  let bestDist = 4;
  for (const flag of KNOWN_FLAGS) {
    if (Math.abs(input.length - flag.length) > 2) continue;
    const d = levenshtein(input, flag);
    if (d < bestDist) { bestDist = d; best = flag; }
  }
  return best;
}

/** Choose between providers which expose the same model during interactive startup. */
function pickProviderForModel(model: string, matches: FetchedModel[]): Promise<FetchedModel | null> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  let selected = 0;

  const lineCount = matches.length + 3;
  let rendered = false;
  const render = () => {
    if (rendered) process.stdout.write(`\x1b[${lineCount}A`);
    rendered = true;
    process.stdout.write(`\x1b[2K  Select provider for ${model}\n`);
    process.stdout.write("\x1b[2K  ↑↓ navigate · Enter select · Esc cancel\n");
    process.stdout.write("\x1b[2K\n");
    for (let i = 0; i < matches.length; i++) {
      process.stdout.write(`\x1b[2K${i === selected ? "  ❯" : "   "} ${matches[i]!.provider}\n`);
    }
  };
  render();

  return new Promise((resolve) => {
    const cleanup = () => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onData);
      stdin.pause();
      process.stdout.write(`\x1b[${lineCount}A`);
      for (let i = 0; i < lineCount; i++) process.stdout.write("\x1b[2K\n");
      process.stdout.write(`\x1b[${lineCount}A`);
    };
    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === "\x1b" || key === "\x03") { cleanup(); resolve(null); return; }
      if (key === "\r" || key === "\n") { const match = matches[selected]!; cleanup(); resolve(match); return; }
      if (key === "\x1b[A" || key === "k") { selected = (selected - 1 + matches.length) % matches.length; render(); return; }
      if (key === "\x1b[B" || key === "j") { selected = (selected + 1) % matches.length; render(); return; }
    };
    stdin.on("data", onData);
  });
}

/** Parse CLI flags into a lightweight record before config loading and validation. */
export function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--") {
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg === "--provider" || arg === "-p") {
      flags.provider = argv[++i] ?? "";
    } else if (arg === "--model" || arg === "-m") {
      flags.model = argv[++i] ?? "";
    } else if (arg.startsWith("--provider=")) {
      flags.provider = arg.split("=")[1] ?? "";
    } else if (arg.startsWith("--model=")) {
      flags.model = arg.split("=")[1] ?? "";
    } else if (arg === "--effort") {
      flags.effort = argv[++i] ?? "";
    } else if (arg.startsWith("--effort=")) {
      flags.effort = arg.slice("--effort=".length);
    } else if (arg === "--auto-accept" || arg === "-y") {
      flags.autoAccept = true;
    } else if (arg === "--stream") {
      flags.stream = true;
    } else if (arg === "--trace") {
      flags.trace = true;
    } else if (arg === "--output-schema") {
      flags.outputSchema = argv[++i] ?? "";
    } else if (arg.startsWith("--output-schema=")) {
      flags.outputSchema = arg.slice("--output-schema=".length);
    } else if (arg === "--deny-writes") {
      flags.denyWrites = true;
    } else if (arg === "--resume" || arg === "-r") {
      flags.resume = argv[i + 1] && !argv[i + 1]!.startsWith("-") ? argv[++i]! : true;
    } else if (arg === "--ollama-host") {
      flags.ollamaHost = argv[++i] ?? "";
    } else if (arg.startsWith("--ollama-host=")) {
      flags.ollamaHost = arg.split("=")[1] ?? "";
    } else if (arg === "--ollama-port") {
      flags.ollamaPort = argv[++i] ?? "";
    } else if (arg.startsWith("--ollama-port=")) {
      flags.ollamaPort = arg.split("=")[1] ?? "";
    } else if (arg === "--ollama-endpoint") {
      flags.ollamaEndpoint = argv[++i] ?? "";
    } else if (arg.startsWith("--ollama-endpoint=")) {
      flags.ollamaEndpoint = arg.split("=")[1] ?? "";
    } else if (arg === "--ollama-api-key") {
      flags.ollamaApiKey = argv[++i] ?? "";
    } else if (arg.startsWith("--ollama-api-key=")) {
      flags.ollamaApiKey = arg.split("=")[1] ?? "";
    } else if (arg === "--print" || arg === "-P") {
      flags.print = true;
      if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
        flags.printPrompt = argv[++i]!;
      }
    } else if (arg === "--permission") {
      flags.permission = argv[++i] ?? "";
    } else if (arg.startsWith("--permission=")) {
      flags.permission = arg.slice("--permission=".length);
    } else if (arg === "--openai-api") {
      flags.openaiApi = argv[++i] ?? "";
    } else if (arg.startsWith("--openai-api=")) {
      flags.openaiApi = arg.slice("--openai-api=".length);
    } else if (arg === "--max-turns") {
      flags.maxTurns = argv[++i] ?? "";
    } else if (arg.startsWith("--max-turns=")) {
      flags.maxTurns = arg.slice("--max-turns=".length);
    } else if (arg === "update" && i === 0) {
      flags.update = true;
      if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
        flags.updateVersion = argv[++i]!;
      }
    } else if (arg === "agents" && i === 0) {
      flags.agents = true;
      if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
        flags.agentsCommand = argv[++i]!;
      }
    } else if (arg === "run" && i === 0) {
      flags.run = true;
    } else if (flags.run && !arg.startsWith("-") && !flags.runPrompt) {
      flags.runPrompt = arg;
    } else if (arg.startsWith("-")) {
      const suggestion = findClosestFlag(arg);
      process.stderr.write(`error: unknown flag ${arg}${suggestion ? `\nDid you mean ${suggestion}?` : ""}\n`);
      process.exit(2);
    }
    i++;
  }
  return flags;
}

/** Read piped stdin input so non-interactive mode can combine it with an explicit prompt. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/** Run a single non-interactive agent turn, optionally streaming text to stdout. */
export async function runPipeMode(
  prompt: string,
  config: AgavConfig,
  provider: LLMProvider,
  options: { stream?: boolean; trace?: boolean; outputSchema?: OutputSchema; stdinContent?: string; includeDynamicContext?: boolean; permissionOverride?: import("./config/config.js").PermissionMode; allowedToolsOverride?: string[]; maxTurns?: number } = {},
): Promise<number> {
  const { stream = false, outputSchema } = options;
  const stdinContent = options.stdinContent ?? await readStdin();

  let expansion;
  try {
    expansion = await expandFileMentions(prompt, { cwd: process.cwd() });
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  for (const warning of expansion.warnings) process.stderr.write(`Warning: ${warning}\n`);

  let fullPrompt = expansion.expanded;
  if (stdinContent) {
    const prefix = `<stdin>\n${stdinContent}\n</stdin>\n\n`;
    fullPrompt = prefix + (expansion.expanded || "Respond to the above input.");
  }

  if (!fullPrompt) {
    process.stderr.write("Error: No prompt provided. Usage: agav run \"your prompt\" or agav -P \"your prompt\"\n");
    return 1;
  }

  const toolRegistry = createToolRegistry();
  const conversation = new ConversationState();
  conversation.setModel(config.model);
  conversation.addUserMessage(fullPrompt, expansion.contentBlocks, undefined, prompt);

  let effectiveSystemPrompt = config.systemPrompt ?? "";
  if (options.includeDynamicContext) {
    const { refreshDynamicContext } = await import("./utils/system-prompt.js");
    const dynamicCtx = await refreshDynamicContext();
    if (dynamicCtx) effectiveSystemPrompt += "\n\n" + dynamicCtx;
  }

  const schemaJson = outputSchema === undefined ? undefined : JSON.stringify(outputSchema);
  const systemPrompt = schemaJson === undefined
    ? effectiveSystemPrompt
    : `${effectiveSystemPrompt}\n\nYour final response MUST be valid JSON matching this schema: ${schemaJson}. Return only the JSON value, with no markdown fences or commentary.`;

  const permissionMode = options.permissionOverride ?? "auto-accept";

  const runTurn = async (streamText: boolean): Promise<{ finalText: string; exitCode: number; wroteStreamText: boolean }> => {
    let finalText = "";
    let wroteStreamText = false;
    let exitCode = 0;
    let madeEdits = false;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      madeEdits = false;
      const loop = runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: config.model,
        systemPrompt,
        effort: config.effort,
        maxTokens: config.maxTokens,
        maxIterations: options.maxTurns ?? config.maxIterations,
        permissionMode,
        allowedTools: options.allowedToolsOverride,
      });

      const trace = options.trace === true;
      let traceStep = 0;
      const traceToolArgs: Map<string, string> = new Map();
      let traceTextAccum = "";

      for await (const event of loop) {
        switch (event.type) {
          case "streaming_text":
            if (streamText) {
              process.stdout.write(event.text);
              wroteStreamText = true;
            }
            if (trace) traceTextAccum += event.text;
            break;
          case "thinking":
            if (trace) {
              process.stderr.write(`\n💭 THOUGHT\n${event.text}\n`);
            }
            break;
          case "tool_call_start":
            if (trace) {
              traceStep++;
              traceToolArgs.set(event.toolCallId, "");
              process.stderr.write(`\n========================= STEP ${traceStep} =========================\n`);
              process.stderr.write(`🎬 ACTION: ${event.toolName}\n`);
            } else {
              process.stderr.write(`  ${icons.pending} ${getToolLabel(event.toolName)}...\n`);
            }
            if (event.toolName === "edit_file" || event.toolName === "write_file") {
              madeEdits = true;
            }
            break;
          case "tool_call_input_delta":
            if (trace) {
              const prev = traceToolArgs.get(event.toolCallId) ?? "";
              traceToolArgs.set(event.toolCallId, prev + event.argsJson);
            }
            break;
          case "tool_confirmation_request":
            if (trace) {
              process.stderr.write(`INPUT:\n${JSON.stringify(event.input, null, 2)}\n`);
            }
            break;
          case "tool_result":
            if (trace) {
              // Print accumulated args if we have them
              const args = traceToolArgs.get(event.toolCallId ?? "");
              if (args) {
                try {
                  const parsed = JSON.parse(args);
                  process.stderr.write(`INPUT:\n${JSON.stringify(parsed, null, 2)}\n`);
                } catch { /* partial args */ }
              }
              const outputPreview = event.output.length > 2000
                ? event.output.slice(0, 2000) + `\n... (truncated, ${event.output.length} chars total)`
                : event.output;
              process.stderr.write(`\nOBSERVATION:\n${outputPreview}\n`);
              if (event.isError) {
                process.stderr.write(`(ERROR)\n`);
              }
            } else {
              if (event.isError) {
                process.stderr.write(`  ${icons.error} ${getToolLabel(event.toolName)}: ${event.output.slice(0, 100)}\n`);
              } else {
                process.stderr.write(`  ${icons.success} ${getToolLabel(event.toolName)}\n`);
              }
            }
            break;
          case "compacted":
            process.stderr.write(`  ${icons.warning} Auto-compacted: ${event.droppedCount} messages summarized\n`);
            break;
          case "assistant_message_complete":
            finalText = event.text;
            if (trace && traceTextAccum) {
              process.stderr.write(`\n🤖 ASSISTANT RESPONSE:\n${traceTextAccum}\n`);
              traceTextAccum = "";
            }
            break;
          case "usage":
            if (trace) {
              process.stderr.write(`📊 USAGE: input=${event.inputTokens} output=${event.outputTokens}` +
                (event.cacheReadTokens ? ` cache_read=${event.cacheReadTokens}` : "") +
                (event.cacheWriteTokens ? ` cache_write=${event.cacheWriteTokens}` : "") + "\n");
            }
            break;
          case "error":
            process.stderr.write(`Error: ${event.error.message}\n`);
            exitCode = 1;
            break;
          case "turn_complete":
            break;
        }
      }

      // If the agent made edits or errored out, we're done
      if (madeEdits || exitCode !== 0 || attempt >= maxRetries) break;

      // Only re-prompt for edits if the user's prompt (not piped content) implies a change
      const expectsEdits = /\b(fix|patch|change|update|modify|edit|write|add|remove|delete|refactor|implement|create|replace|rewrite|migrate)\b/.test(prompt.toLowerCase());
      if (!expectsEdits) break;

      // Re-prompt: agent analyzed but didn't edit
      process.stderr.write(`  ${icons.warning} No edits made — re-prompting (attempt ${attempt + 2}/${maxRetries + 1})...\n`);
      conversation.addInternalUserMessage(NO_EDITS_PROMPT);
    }

    return { finalText, exitCode, wroteStreamText };
  };

  // Schema output must stay buffered so an invalid first attempt never contaminates stdout.
  let result = await runTurn(stream && outputSchema === undefined);
  if (result.exitCode !== 0) return result.exitCode;

  if (outputSchema !== undefined) {
    let validate;
    try {
      validate = createOutputValidator(outputSchema);
    } catch (error) {
      process.stderr.write(`Error: Invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }

    let validation = validateOutput(result.finalText, validate);
    if (!validation.valid) {
      const details = formatValidationErrors(validation);
      process.stderr.write(`Schema validation failed; retrying once: ${details}\n`);
      conversation.addInternalUserMessage(schemaRetryPrompt(details));
      result = await runTurn(false);
      if (result.exitCode !== 0) return result.exitCode;
      validation = validateOutput(result.finalText, validate);
    }

    if (!validation.valid) {
      process.stderr.write(`Error: Response failed JSON Schema validation after retry: ${formatValidationErrors(validation)}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(validation.value)}\n`);
    return 0;
  }

  if (stream && result.wroteStreamText) {
    process.stdout.write("\n");
  } else if (result.finalText) {
    process.stdout.write(result.finalText + "\n");
  }
  return result.exitCode;
}

let startupFinished = false;

/**
 * Whether provider/model resolution finished. Lets the top-level handler in
 * cli.tsx avoid blaming a mid-session crash on startup.
 */
export function hasStartupFinished(): boolean {
  return startupFinished;
}

export async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(`
  Agav — terminal-native AI agent

  Usage
    $ agav [options]
    $ agav run "prompt"            Non-interactive agent mode (CI/scripting)
    $ agav update                  Update to the latest version
    $ agav agents [command]        Manage service agents
    $ agav --print "prompt"
    $ cat file | agav -P "explain this"

  Options
    --provider, -p       LLM provider: anthropic, openai, openrouter, gemini, vertex-ai, or ollama (default: anthropic)
    --model, -m          Model name (default: claude-sonnet-4-20250514 / gpt-4o / llama3.2)
    --effort             Reasoning effort: low, medium, high, or max (default: high)
    --ollama-host        Ollama host (default: localhost)
    --ollama-port        Ollama port (default: 11434)
    --ollama-endpoint    Full Ollama base URL, e.g. http://192.168.1.5:11434
    --ollama-api-key     API key for Ollama (sets Authorization: Bearer header)
    --print, -P          Non-interactive mode: run prompt, print result, exit
    --stream             Stream text to stdout in real time with --print
    --output-schema      Require pipe-mode output to match an inline JSON Schema or @file
    --openai-api         OpenAI API mode: responses or chat (default: responses)
    --permission         JSON tool permissions for run mode (or set AGAV_PERMISSION env var)
    --resume, -r [id]    Resume a session (list if no id, prefix match if given)
    --auto-accept, -y    Skip tool confirmations
    --deny-writes        Block all write operations
    --help, -h           Show this help
    --version, -v        Show version

  Agent Commands
    $ agav agents list             List installed agents
    $ agav agents install <url>    Install agent from git URL or local path
    $ agav agents remove <name>    Uninstall an agent
    $ agav agents enable <name>    Enable an agent
    $ agav agents disable <name>   Disable an agent

  Examples
    $ agav
    $ agav --provider openai --model gpt-4o
    $ agav --provider vertex-ai --model vertex/gemini-3.5-flash
    $ agav run "review the code in src/"
    $ agav run --permission '{"bash":"deny"}' "check for security issues"
    $ agav -P "what does this project do?"
    $ agav -P --stream "explain this repository"
    $ cat error.log | agav -P "explain this error"
    $ agav agents install https://github.com/user/repo/agents/jira
    $ agav agents list
`);
    process.exit(0);
  }

  if (flags.version) {
    const { VERSION } = await import("./version.js");
    console.log(VERSION);
    process.exit(0);
  }

  // Force update: agav update
  if (flags.update) {
    const { forceUpdate } = await import("./utils/auto-update.js");
    const targetVersion = typeof flags.updateVersion === "string" ? flags.updateVersion : undefined;
    const ok = await forceUpdate(targetVersion);
    process.exit(ok ? 0 : 1);
    return;
  }

  // Agent management: agav agents <command>
  if (flags.agents) {
    const { runAgentsCommand } = await import("./cli/agents-cli.js");
    const agentsCommand = typeof flags.agentsCommand === "string" ? flags.agentsCommand : undefined;
    // Find "agents" position in argv to correctly slice remaining args
    const agentsIdx = process.argv.indexOf("agents");
    const argsStartIndex = agentsIdx >= 0
      ? agentsIdx + (agentsCommand ? 2 : 1)
      : (agentsCommand ? 4 : 3);
    const exitCode = await runAgentsCommand(agentsCommand, process.argv.slice(argsStartIndex));
    process.exit(exitCode);
    return;
  }

  // Auto-update check (silent on failure, skipped in CI/pipe mode)
  try {
    const { checkAndUpdate } = await import("./utils/auto-update.js");
    await checkAndUpdate();
  } catch {
    // Never block startup on update failures
  }

  let outputSchema: OutputSchema | undefined;
  if (flags.print && typeof flags.outputSchema === "string") {
    try {
      outputSchema = await loadOutputSchema(flags.outputSchema);
      createOutputValidator(outputSchema);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  const config = await loadConfig();
  const keybindings = await loadKeybindings();

  let cliProvider: ProviderName | undefined;
  if (typeof flags.provider === "string") {
    const p = flags.provider;
    if (!isProviderName(p)) {
      console.error(`Unknown provider: ${p}. Use "anthropic", "openai", "openrouter", "gemini", "vertex-ai", or "ollama".`);
      process.exit(1);
    }
    cliProvider = p;
  }

  // Apply explicit CLI connection overrides last so they win over config and environment defaults.
  if (typeof flags.openaiApi === "string" && (flags.openaiApi === "chat" || flags.openaiApi === "responses")) {
    config.openaiApi = flags.openaiApi;
  }
  if (typeof flags.ollamaEndpoint === "string" && flags.ollamaEndpoint) {
    config.ollamaEndpoint = flags.ollamaEndpoint as string;
  }
  if (typeof flags.ollamaHost === "string" && flags.ollamaHost) {
    config.ollamaHost = flags.ollamaHost as string;
  }
  if (typeof flags.ollamaPort === "string" && flags.ollamaPort) {
    const p = parseInt(flags.ollamaPort as string, 10);
    if (!isNaN(p)) config.ollamaPort = p;
  }
  if (typeof flags.ollamaApiKey === "string" && flags.ollamaApiKey) {
    config.ollamaApiKey = flags.ollamaApiKey as string;
  }
  if (typeof flags.effort === "string") {
    if (!isEffortLevel(flags.effort)) {
      console.error(`Unknown effort level: ${flags.effort}. Use "low", "medium", "high", or "max".`);
      process.exit(1);
    }
    config.effort = flags.effort;
  }

  if (!config.systemPrompt) {
    config.systemPrompt = await buildSystemPrompt();
  }

  if (flags.autoAccept) {
    config.permissionMode = "auto-accept";
  } else if (flags.denyWrites) {
    config.permissionMode = "deny-writes";
  }

  loadTheme(config.theme);

  // Resolve an optional resume target before rendering so the app starts with restored context.
  let resumeMessages: import("./providers/types.js").Message[] | undefined;
  let resumeSessionId: string | undefined;
  let resumeTokenUsage: import("./config/history.js").SessionTokenUsage | undefined;
  let resumeCompacted: boolean | undefined;
  let resumeSessionName: string | undefined;
  let resumeSelection: Pick<import("./config/history.js").SessionRecord, "provider" | "model"> | undefined;

  if (flags.resume) {
    const { listSessions, loadSession } = await import("./config/history.js");
    const sessions = await listSessions();

    if (sessions.length === 0) {
      console.error("\n  No saved sessions found.\n");
      process.exit(0);
    }

    if (flags.resume === true) {
      const { pickSession } = await import("./utils/session-picker.js");
      const picked = await pickSession(sessions);
      if (!picked) {
        process.exit(0);
      }
      const session = await loadSession(picked.id);
      if (!session) {
        console.error("\n  Failed to load session.\n");
        process.exit(1);
      }
      resumeMessages = session.messages;
      resumeSessionId = session.id;
      resumeTokenUsage = session.tokenUsage;
      resumeCompacted = session.compacted;
      resumeSessionName = session.name;
      resumeSelection = session;
    } else {
      // ID prefix given — find matching session
      const prefix = String(flags.resume);
      const match = sessions.find((s) => s.id.startsWith(prefix));
      if (!match) {
        console.error(`\n  No session matching "${prefix}". Use --resume to list all.\n`);
        process.exit(1);
      }
      const session = await loadSession(match.id);
      if (!session) {
        console.error(`\n  Failed to load session ${match.id}.\n`);
        process.exit(1);
      }
      console.error(`\n  Resuming: ${session.title} (${session.messages.length} msgs)\n`);
      resumeMessages = session.messages;
      resumeSessionId = session.id;
      resumeTokenUsage = session.tokenUsage;
      resumeCompacted = session.compacted;
      resumeSessionName = session.name;
      resumeSelection = session;
    }
  }

  Object.assign(config, resolveStartupSelection(config, {
    cliProvider,
    cliModel: typeof flags.model === "string" ? flags.model : undefined,
    session: resumeSelection,
  }));

  // An explicit provider and a provider-qualified model remain authoritative.
  // Otherwise, reuse the /model catalog to route an explicit model to the
  // provider that actually offers it.
  const cliModel = typeof flags.model === "string" && flags.model ? flags.model : undefined;
  if (!cliProvider && !resumeSelection && cliModel) {
    const { models } = await fetchAvailableModels(config);
    const matches = findMatchingModels(models, cliModel);
    if (matches.length === 1) {
      // Keep the provider catalog's canonical identifier. Vertex lists models
      // as `vertex/gemini-*`; retaining that prefix makes the startup choice
      // unambiguous and routes the subsequent request through Vertex AI.
      config.provider = matches[0]!.provider as ProviderName;
      config.model = matches[0]!.id;
    } else if (matches.length > 1) {
      if (!process.stdin.isTTY) {
        process.stderr.write(`\n  Agav — model ${JSON.stringify(cliModel)} is available from multiple providers: ${matches.map((match) => match.provider).join(", ")}. Use --provider to choose one.\n\n`);
        process.exit(1);
      }
      const picked = await pickProviderForModel(cliModel, matches);
      if (!picked) process.exit(0);
      config.provider = picked.provider as ProviderName;
      config.model = picked.id;
    }
  }

  // Plain `agav` may fall back to another configured provider. Explicit and
  // resumed selections are pinned and must report their own missing settings.
  if (!cliProvider && !resumeSelection) {
    // Keep an explicit --model: falling back to a different provider should not
    // silently discard the model the user asked for.
    const selected = selectConfiguredProvider(config, {
      keepModel: typeof flags.model === "string",
    });
    if (!selected) {
      process.stderr.write(`\n  Agav — ${noProviderCredentialsError()}\n\n`);
      process.exit(1);
    }
    Object.assign(config, selected);
  }

  const configurationError = providerConfigurationError(config);
  if (configurationError) {
    process.stderr.write(`\n  Agav — ${configurationError}\n\n`);
    process.exit(1);
  }

  // If Ollama is selected without a model, query the local server and choose one.
  if (config.provider === "ollama" && !config.model) {
    const ollamaBase = config.ollamaEndpoint ?? `http://${config.ollamaHost ?? "localhost"}:${config.ollamaPort ?? 11434}`;
    let models: string[] = [];
    try {
      const res = await fetch(`${ollamaBase}/api/tags`);
      if (res.ok) {
        const data = await res.json() as { models?: { name: string }[] };
        models = (data.models ?? []).map((model) => model.name).filter(Boolean);
      }
    } catch {}
    if (models.length === 0) {
      process.stderr.write("\n  Agav — no Ollama models found. Specify --model or run `ollama pull <model>`.\n\n");
      process.exit(1);
    }
    config.model = models[0] ?? defaultModelForProvider("ollama");
    // Auto-picking the first installed model is a guess, so name the others —
    // otherwise there is no hint that --model would have chosen differently.
    process.stderr.write(
      `\n  Agav — using Ollama model ${config.model}.`
      + (models.length > 1 ? ` Also installed: ${models.slice(1).join(", ")}.` : "")
      + "\n\n",
    );
  }

  startupFinished = true;

  // Short-circuit into non-interactive mode before the Ink UI is rendered.
  if (flags.print) {
    const provider = createProvider(config);
    const exitCode = await runPipeMode(String(flags.printPrompt ?? ""), config, provider, {
      stream: flags.stream === true,
      outputSchema,
    });
    process.exit(exitCode);
    return;
  }

  if (flags.run) {
    const provider = createProvider(config);
    const runOptions: Parameters<typeof runPipeMode>[3] = {
      stream: true,
      includeDynamicContext: true,
    };

    // Parse permission from --permission flag or AGAV_PERMISSION env var
    const permissionJson = (typeof flags.permission === "string" && flags.permission)
      || process.env["AGAV_PERMISSION"];
    if (permissionJson) {
      try {
        const parsed = JSON.parse(permissionJson);
        const allowed = Object.entries(parsed)
          .filter(([k, v]) => k !== "*" && v === "allow")
          .map(([k]) => k);
        if (parsed["*"] === "deny") {
          // Explicit allowlist: auto-accept listed tools, hard-block everything else.
          // Empty allowlist = block all non-safe tools.
          runOptions.permissionOverride = "auto-accept";
          runOptions.allowedToolsOverride = allowed.length > 0 ? allowed : ["__none__"];
        } else {
          const hasDeny = Object.values(parsed).some((v) => v === "deny");
          runOptions.permissionOverride = hasDeny ? "deny-writes" : "auto-accept";
        }
      } catch {
        process.stderr.write("Error: Invalid JSON in --permission / AGAV_PERMISSION\n");
        process.exit(1);
      }
    }

    if (typeof flags.maxTurns === "string" && flags.maxTurns) {
      const n = parseInt(flags.maxTurns, 10);
      if (!isNaN(n) && n > 0) runOptions.maxTurns = n;
    }

    if (flags.trace) {
      runOptions.trace = true;
    }

    const exitCode = await runPipeMode(String(flags.runPrompt ?? ""), config, provider, runOptions);
    process.exit(exitCode);
    return;
  }

  // Every non-interactive path has returned by now, so the Ink UI is next.
  // Ink needs raw mode, which requires a TTY — without this guard a piped
  // stdin (e.g. an installer launching us through a pipe) surfaces as
  // an unreadable React stack trace instead of an actionable message.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "\n  Agav's interactive UI needs a terminal, but stdin is not a TTY.\n\n" +
        "    • Run `agav` directly from your shell.\n" +
        "    • For piped or scripted use:  agav -P \"your prompt\"\n" +
        "    • Just installed through a pipe? That pipe is still attached —\n" +
        "      open your terminal and run `agav`.\n\n",
    );
    process.exit(1);
  }

  /** Print a subtle reminder pointing at the most recent resumable session. */
  async function showResumeHint() {
    try {
      const { listSessions } = await import("./config/history.js");
      const sessions = await listSessions();
      if (sessions.length > 0) {
        const latest = sessions[0]!;
        const shortId = latest.id;
        process.stderr.write(`\n${dim(`To resume: agav --resume ${shortId}`)}\n\n`);
      }
    } catch {}
  }

  // Mark clean exits so crash recovery only offers truly interrupted sessions.
  process.on("exit", () => {
    markCleanExitSync();
    stopAllA2AAgents();
  });
  process.on("SIGINT", async () => {
    markCleanExit();
    stopAllA2AAgents();
    await showResumeHint();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    markCleanExit();
    stopAllA2AAgents();
    await showResumeHint();
    process.exit(0);
  });

  const { getGitContext } = await import("./utils/git.js");
  const { detectKittyKeyboard } = await import("./utils/terminal-keyboard.js");
  // The keyboard probe waits on the terminal, so overlap it with the git lookup
  // rather than adding its timeout to startup. Both settle rather than reject.
  const [gitContext, enhancedKeyboard] = await Promise.all([getGitContext(), detectKittyKeyboard()]);

  const { waitUntilExit } = render(<App config={config} keybindings={keybindings} resumeMessages={resumeMessages} resumeSessionId={resumeSessionId} resumeTokenUsage={resumeTokenUsage} resumeCompacted={resumeCompacted} resumeSessionName={resumeSessionName} repoBranch={gitContext?.branch} enhancedKeyboard={enhancedKeyboard} />, {
    exitOnCtrlC: true,
    // Alt-screen keeps the UI self-contained (no scrollback pollution, no
    // flicker on terminals without DEC 2026). In-app scrolling is handled by
    // the ScrollBox viewport + mouse wheel, so native scrollback isn't needed.
    alternateScreen: true,
    kittyKeyboard: { mode: enhancedKeyboard ? "enabled" : "disabled", flags: ["disambiguateEscapeCodes"] },
  });

  await waitUntilExit();
  stopAllA2AAgents();
  await showResumeHint();

  // Ensure the process exits even if stray handles (timers, sockets, etc.)
  // are still referenced.  The "exit" event handler above will run
  // synchronously when process.exit() is called, so markCleanExitSync()
  // and stopAllA2AAgents() still fire.
  process.exit(0);
}
