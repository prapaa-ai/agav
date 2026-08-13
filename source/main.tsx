import React from "react";
import { render } from "ink";
import App from "./app.js";
import { isEffortLevel, loadConfig, type AgavConfig } from "./config/config.js";
import { createProvider } from "./providers/registry.js";
import type { LLMProvider } from "./providers/types.js";
import { buildSystemPrompt } from "./utils/system-prompt.js";
import { loadSessionState, markCleanExit } from "./config/session-state.js";
import { loadTheme } from "./config/theme.js";
import { ConversationState } from "./agent/conversation.js";
import { runAgentLoop } from "./agent/loop.js";
import { createToolRegistry } from "./tools/registry-factory.js";
import { getToolLabel } from "./utils/tool-labels.js";
import { loadKeybindings } from "./config/keybindings.js";
import { dim, icons } from "./utils/color.js";
import {
  createOutputValidator,
  formatValidationErrors,
  loadOutputSchema,
  validateOutput,
  type OutputSchema,
} from "./utils/output-schema.js";
import { writeAgavTrajectory, type AgavRunUsage } from "./utils/trajectory.js";

const KNOWN_FLAGS = [
  "--help", "-h", "--version", "-v", "--provider", "-p", "--model", "-m",
  "--effort", "--auto-accept", "-y", "--stream", "--output-schema", "--deny-writes",
  "--resume", "-r", "--ollama-host", "--ollama-port", "--ollama-endpoint",
  "--ollama-api-key", "--print", "-P", "--permission", "--openai-api", "--max-turns",
  "--trajectory",
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
    } else if (arg === "--trajectory") {
      flags.trajectory = argv[++i] ?? "";
    } else if (arg.startsWith("--trajectory=")) {
      flags.trajectory = arg.slice("--trajectory=".length);
    } else if (arg === "update" && i === 0) {
      flags.update = true;
      if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
        flags.updateVersion = argv[++i]!;
      }
    } else if (arg === "run" && i === 0) {
      flags.run = true;
    } else if (flags.run && !flags.runPrompt) {
      // First positional after `run` is the prompt, even if it starts with
      // "-" (e.g. an instruction beginning with a markdown bullet). Known
      // flags are matched by the earlier branches, so anything reaching here
      // in run mode before a prompt is captured is the prompt itself.
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
  options: { stream?: boolean; outputSchema?: OutputSchema; stdinContent?: string; includeDynamicContext?: boolean; permissionOverride?: import("./config/config.js").PermissionMode; allowedToolsOverride?: string[]; maxTurns?: number; trajectoryPath?: string } = {},
): Promise<number> {
  const { stream = false, outputSchema } = options;
  const stdinContent = options.stdinContent ?? await readStdin();

  // File @-mention expansion is intentionally disabled in non-interactive
  // (pipe / `agav run` / `-P`) mode. Here the prompt is a complete instruction
  // supplied by the caller, so a bare "@word" — e.g. a Vim register (`@a`), a
  // Python decorator, or an email handle — must pass through literally rather
  // than being treated as a file attachment (which would abort the run with
  // "File not found" when no such file exists). Callers that want file contents
  // in the prompt can pipe them via stdin, which is wrapped below.
  let fullPrompt = prompt;
  if (stdinContent) {
    const prefix = `<stdin>\n${stdinContent}\n</stdin>\n\n`;
    fullPrompt = prefix + (prompt || "Respond to the above input.");
  }

  if (!fullPrompt) {
    process.stderr.write("Error: No prompt provided. Usage: agav run \"your prompt\" or agav -P \"your prompt\"\n");
    return 1;
  }

  const toolRegistry = createToolRegistry();
  const conversation = new ConversationState();
  conversation.setModel(config.model);
  conversation.addUserMessage(fullPrompt, undefined, undefined, prompt);

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

  // Trajectory capture: accumulate token usage (the loop's `usage` events are
  // otherwise dropped in pipe mode) and record run timing, so we can emit a
  // faithful native trajectory after the run regardless of how it exits.
  const usage: AgavRunUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  const startedAt = new Date().toISOString();
  const flushTrajectory = async (): Promise<void> => {
    if (!options.trajectoryPath) return;
    try {
      await writeAgavTrajectory(options.trajectoryPath, {
        model: config.model,
        provider: config.provider,
        startedAt,
        finishedAt: new Date().toISOString(),
        usage,
        messages: conversation.getMessages(),
      });
    } catch (err) {
      process.stderr.write(
        `Warning: failed to write trajectory: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

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

      for await (const event of loop) {
        switch (event.type) {
          case "streaming_text":
            if (streamText) {
              process.stdout.write(event.text);
              wroteStreamText = true;
            }
            break;
          case "tool_call_start":
            process.stderr.write(`  ${icons.pending} ${getToolLabel(event.toolName)}...\n`);
            if (event.toolName === "edit_file" || event.toolName === "write_file") {
              madeEdits = true;
            }
            break;
          case "tool_result":
            if (event.isError) {
              process.stderr.write(`  ${icons.error} ${getToolLabel(event.toolName)}: ${event.output.slice(0, 100)}\n`);
            } else {
              process.stderr.write(`  ${icons.success} ${getToolLabel(event.toolName)}\n`);
            }
            break;
          case "compacted":
            process.stderr.write(`  ${icons.warning} Auto-compacted: ${event.droppedCount} messages summarized\n`);
            break;
          case "usage":
            usage.input_tokens += event.inputTokens ?? 0;
            usage.output_tokens += event.outputTokens ?? 0;
            usage.cache_read_tokens += event.cacheReadTokens ?? 0;
            usage.cache_write_tokens += event.cacheWriteTokens ?? 0;
            break;
          case "assistant_message_complete":
            finalText = event.text;
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
      conversation.addUserMessage(
        "You analyzed the code but did not make any changes. Now write the actual fix. Use edit_file or write_file to modify the source code. Do not just explain — implement the fix."
      );
    }

    return { finalText, exitCode, wroteStreamText };
  };

  // Schema output must stay buffered so an invalid first attempt never contaminates stdout.
  let result = await runTurn(stream && outputSchema === undefined);
  // A trajectory is written on every post-loop exit path (including errors) via
  // the finally block, so the adapter always has a transcript to convert.
  try {
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
        conversation.addUserMessage(
          `Your previous response was invalid. ${details}\nCorrect it and return ONLY valid JSON matching the required schema, with no markdown fences or commentary.`,
        );
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
  } finally {
    await flushTrajectory();
  }
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
    $ agav --print "prompt"
    $ cat file | agav -P "explain this"

  Options
    --provider, -p       LLM provider: anthropic, openai, gemini, or ollama (default: anthropic)
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
    --trajectory         Write a native JSON trajectory of the run to the given path
    --resume, -r [id]    Resume a session (list if no id, prefix match if given)
    --auto-accept, -y    Skip tool confirmations
    --deny-writes        Block all write operations
    --help, -h           Show this help
    --version, -v        Show version

  Examples
    $ agav
    $ agav --provider openai --model gpt-4o
    $ agav run "review the code in src/"
    $ agav run --permission '{"bash":"deny"}' "check for security issues"
    $ agav -P "what does this project do?"
    $ agav -P --stream "explain this repository"
    $ cat error.log | agav -P "explain this error"
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

  if (typeof flags.provider === "string") {
    const p = flags.provider;
    if (p !== "anthropic" && p !== "openai" && p !== "ollama" && p !== "gemini") {
      console.error(`Unknown provider: ${p}. Use "anthropic", "openai", "gemini", or "ollama".`);
      process.exit(1);
    }
    const providerChanged = p !== config.provider;
    config.provider = p;
    if (providerChanged && typeof flags.model !== "string") {
      if (p === "openai") config.model = "gpt-5.4-mini";
      else if (p === "gemini") config.model = "gemini-3.5-flash-lite";
      else if (p === "ollama") config.model = "";
      else config.model = "claude-sonnet-4-20250514";
    }
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
  if (typeof flags.model === "string") {
    config.model = flags.model;
  }
  if (typeof flags.effort === "string") {
    if (!isEffortLevel(flags.effort)) {
      console.error(`Unknown effort level: ${flags.effort}. Use "low", "medium", "high", or "max".`);
      process.exit(1);
    }
    config.effort = flags.effort;
  }

  // If Ollama is selected without a model, query the local server and prompt the user to choose one.
  if (config.provider === "ollama" && typeof flags.model !== "string") {
    const ollamaBase =
      config.ollamaEndpoint ??
      `http://${config.ollamaHost ?? "localhost"}:${config.ollamaPort ?? 11434}`;
    let models: string[] = [];
    try {
      const res = await fetch(`${ollamaBase}/api/tags`);
      if (res.ok) {
        const data = await res.json() as { models?: { name: string }[] };
        models = (data.models ?? []).map((m) => m.name).filter(Boolean);
      }
    } catch {}

    if (models.length > 0) {
      process.stdout.write("\n  Available Ollama models:\n");
      models.forEach((name, i) => process.stdout.write(`    ${i + 1}. ${name}\n`));
      process.stdout.write(`\n  Starting with: ${models[0]}\n  Use /model to switch.\n\n`);
      config.model = models[0]!;
    } else {
      console.error("\n  No Ollama models found. Specify a model:\n");
      console.error("    agav --provider ollama --model llama3.2\n");
      console.error("  Or pull one first: ollama pull llama3.2\n");
      process.exit(1);
    }
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
      if (typeof flags.model !== "string") {
        config.model = session.model || config.model;
      }
      if (typeof flags.provider !== "string" && (session.provider === "anthropic" || session.provider === "openai" || session.provider === "ollama" || session.provider === "gemini")) {
        config.provider = session.provider;
      }
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
      if (typeof flags.model !== "string") {
        config.model = session.model || config.model;
      }
      if (typeof flags.provider !== "string" && (session.provider === "anthropic" || session.provider === "openai" || session.provider === "ollama" || session.provider === "gemini")) {
        config.provider = session.provider;
      }
    }
  }

  if (config.provider !== "ollama") {
    const keyMap: Record<string, keyof AgavConfig> = {
      anthropic: "anthropicApiKey",
      openai: "openaiApiKey",
      gemini: "geminiApiKey",
    };
    const finalKey = keyMap[config.provider] ?? "anthropicApiKey";
    if (!config[finalKey]) {
      const explicitProvider = typeof flags.provider === "string";
      if (!explicitProvider) {
        // Auto-switch to whichever provider has a key
        if (config.anthropicApiKey) {
          config.provider = "anthropic";
          config.model = "claude-sonnet-4-20250514";
        } else if (config.openaiApiKey) {
          config.provider = "openai";
          config.model = "gpt-5.4-mini";
        } else if (config.geminiApiKey) {
          config.provider = "gemini";
          config.model = "gemini-3.5-flash-lite";
        } else {
          const message = `\n  Agav — no API key found.\n  Set one of:\n    export ANTHROPIC_API_KEY="sk-ant-..."\n    export OPENAI_API_KEY="sk-..."\n    export GEMINI_API_KEY="..."\n  Or start Ollama: agav --provider ollama\n`;
          process.stderr.write(message);
          process.exit(1);
        }
      } else {
        const envMap: Record<string, string> = {
          anthropic: "ANTHROPIC_API_KEY",
          openai: "OPENAI_API_KEY",
          gemini: "GEMINI_API_KEY",
        };
        const keyName = envMap[config.provider] ?? "API_KEY";
        const message = `\n  Agav — ${keyName} not set.\n  Export it:  export ${keyName}="your-key"\n`;
        process.stderr.write(message);
        process.exit(1);
      }
    }
  }

  // Short-circuit into non-interactive mode before the Ink UI is rendered.
  if (flags.print) {
    const provider = createProvider(config);
    const exitCode = await runPipeMode(String(flags.printPrompt ?? ""), config, provider, {
      stream: flags.stream === true,
      outputSchema,
      trajectoryPath: typeof flags.trajectory === "string" && flags.trajectory ? flags.trajectory : undefined,
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
    if (typeof flags.trajectory === "string" && flags.trajectory) {
      runOptions.trajectoryPath = flags.trajectory;
    }

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

    const exitCode = await runPipeMode(String(flags.runPrompt ?? ""), config, provider, runOptions);
    process.exit(exitCode);
    return;
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
  process.on("exit", () => { markCleanExit(); });
  process.on("SIGINT", async () => {
    markCleanExit();
    await showResumeHint();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    markCleanExit();
    await showResumeHint();
    process.exit(0);
  });

  const { waitUntilExit } = render(<App config={config} keybindings={keybindings} resumeMessages={resumeMessages} resumeSessionId={resumeSessionId} resumeTokenUsage={resumeTokenUsage} resumeCompacted={resumeCompacted} resumeSessionName={resumeSessionName} />, {
    exitOnCtrlC: true,
  });

  await waitUntilExit();
  await showResumeHint();
}
