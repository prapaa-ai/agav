---
title: CLI Reference
description: Startup modes, options, environment variables, and update commands
order: 2
---

# CLI Reference

## Modes

```bash
agav                         # Interactive terminal UI
agav run "prompt"            # Non-interactive agent mode with dynamic context
agav -P "prompt"             # Print one final response and exit
agav update [version]        # Update the installed release
```

### --max-turns

`--max-turns <number>` caps agent iterations **per prompt** across interactive, print (`-P`), and run (`run`) modes.

- Interactive: the cap applies to each user turn in the session. The budget resets for every new prompt and is shared with subagents, skills, and tool calls.
- Print mode: a single prompt runs with the cap; when reached the agent summarizes its work and stops.
- Run mode: the cap limits internal model/tool iterations for the task prompt.

The flag overrides `maxIterations` in configuration for the current session only. On resume, the session history is kept but the cap is reapplied to new prompts. Values must be positive safe integers (1–9,007,199,254,740,991); invalid or missing values fail before work starts. Subagents, native agents, and skills share the active allowance. Automatic continuations and JSON-schema corrections do not reset it; independent prompts, including new shell submissions, do.

## Options

| Option | Description |
| --- | --- |
| `--provider`, `-p` | `anthropic`, `openai`, `openrouter`, `nvidia`, `deepseek`, `gemini`, `vertex-ai`, or `ollama` |
| `--model`, `-m` | Provider model identifier |
| `--cwd <dir>` | Set the launch working directory; absolute and launch-relative paths are supported |
| `--trajectory <path>` | Export a run/print transcript, aggregate token usage, and timing as JSON; not supported for interactive sessions |
| `--effort` | `low`, `medium`, `high`, or `max` |
| `--ollama-host` | Ollama host when no complete endpoint is set |
| `--ollama-port` | Ollama port |
| `--ollama-endpoint` | Complete Ollama base URL |
| `--ollama-api-key` | Ollama bearer token |
| `--print`, `-P` | Print mode |
| `--stream` | Stream print-mode response text |
| `--output-schema <json\|@file>` | Validate print-mode output against JSON Schema |
| `--permission <json>` | Tool policy for `agav run` |
| `--max-turns <number>` | Limit the number of agent iterations per prompt in interactive, print, and run modes |
| `--resume`, `-r [id]` | Open the session picker or resume by ID prefix |
| `--auto-accept`, `-y` | Skip normal tool confirmations |
| `--openai-api` | OpenAI API mode: `responses` (default) or `chat`. Use `chat` for OpenAI-compatible endpoints that don't support the Responses API. |
| `--deny-writes` | Block write operations |
| `--version`, `-v` | Print the version |
| `--help`, `-h` | Print help |

Both `--option value` and `--option=value` are accepted for provider, model, effort, working directory, trajectory path, Ollama values, output schema, permissions, and max turns.

### Working directory and literal arguments

```bash
agav --cwd ../service
agav --cwd=/path/to/repo run "review the API"
agav run -- "explain --max-turns=2 literally"
```

`--cwd` changes the working directory before project configuration, context, and relative files are resolved. A missing, inaccessible, or non-directory target produces a startup error. Relative paths are resolved from the original launch directory; automatic-update restarts do not apply them twice.

`--` ends Agav option parsing: following tokens are literal prompt or delegated agent/skill arguments, even when they resemble flags. Place Agav options before this separator. See [trajectory exports](/workflows/non-interactive#trajectory-exports) for audit and benchmark output.

## Startup provider and model selection

When you start a plain `agav` session, the provider and model are resolved in this order:

1. **Explicit flags** — `--provider` and `--model` always win. If you pass `--provider` without `--model`, Agav reuses the saved model only when it belongs to that provider, otherwise it falls back to the provider's default model.
2. **Resumed session** — with `--resume`, the session's own provider and model are used unless overridden by a flag.
3. **Last used** — with no flags and no resume, Agav reuses the provider and model from your most recent session, so a new session opens with the same model you last worked in.
4. **Config defaults** — if there is no prior session, the `provider`/`model` in `~/.agav/config.json` (or the built-in default) apply.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic credential |
| `OPENAI_API_KEY` | OpenAI credential |
| `OPENROUTER_API_KEY` | OpenRouter credential (`sk-or-v1-...`) |
| `NVIDIA_API_KEY` | NVIDIA NIM credential (`nvapi-...`) |
| `DEEPSEEK_API_KEY` | DeepSeek credential (`sk-...`) |
| `OPENAI_BASE_URL` | Override the OpenAI base URL to target an OpenAI-compatible endpoint |
| `GEMINI_API_KEY` | Gemini credential |
| `VERTEX_AI_CREDENTIALS_PATH` | Path to a Google Cloud service-account JSON file; enables Vertex AI |
| `VERTEX_AI_LOCATION` | Vertex AI region, or `global` for the multi-region endpoint (default `global`) |
| `OLLAMA_ENDPOINT` | Complete Ollama endpoint |
| `OLLAMA_HOST` / `OLLAMA_PORT` | Ollama address components |
| `OLLAMA_API_KEY` | Ollama bearer token |
| `AGAV_PERMISSION` | JSON policy used by `agav run` |
| `AGAV_NO_UPDATE=1` | Disable automatic update checks |
| `AGAV_NO_SANDBOX=1` | Disable automatic shell sandbox selection |
| `AGAV_MARKETPLACE_URL` | Override the default agent marketplace URL |
| `LIBREOFFICE_PATH` | Office document conversion executable |

## Agent subcommands

```bash
agav agents                            # Alias for agav agents list
agav agents list                       # List installed agents grouped by origin
agav agents install <url|path>         # Install from URL or local directory
agav agents remove <name>              # Remove from disk
agav agents enable <name>              # Enable a disabled agent
agav agents disable <name>             # Disable without removing files
```

| Option | Description |
| --- | --- |
| `--alias <name>` | Install under an alternative name (resolves name conflicts) |
| `--destination global\|project` | Install scope; defaults to `global` |

Local paths and GitHub repository URLs are both supported for `install`. For GitHub, Agav uses sparse checkout to download only the agent directory.

## Skill subcommands

```bash
agav skills                            # Alias for agav skills list
agav skills list                       # List all skills grouped by origin, with state
agav skills add <url|path>             # Install from a URL or local path
agav skills remove <name>             # Uninstall a global skill
agav skills disable <name>            # Disable a skill (bundled skills included)
agav skills enable <name>             # Re-enable a disabled skill
agav skills clear                     # Remove all user-installed skills
```

Bundled skills are compiled into the binary and cannot be removed, but `disable` turns them off without deleting anything. The enabled/disabled state is stored in `~/.agav/skills/registry.json`. Changes take effect on the next start.

## MCP authentication subcommands

```bash
agav mcp auth <name>          # Explicit browser OAuth sign-in
agav mcp logout <name>        # Delete local cached OAuth credentials
```

These commands use configured MCP servers and do not require an LLM provider. Restart an existing session after standalone sign-in or logout; use `/mcp auth <name>` or `/mcp logout <name>` inside the session for immediate reconnection or disconnection. Logout does not revoke provider authorization grants. See [MCP authentication](/features/mcp#oauth-authentication) for compatibility and credential storage.
