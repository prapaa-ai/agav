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

## Options

| Option | Description |
| --- | --- |
| `--provider`, `-p` | `anthropic`, `openai`, `gemini`, `vertex-ai`, or `ollama` |
| `--model`, `-m` | Provider model identifier |
| `--effort` | `low`, `medium`, `high`, or `max` |
| `--ollama-host` | Ollama host when no complete endpoint is set |
| `--ollama-port` | Ollama port |
| `--ollama-endpoint` | Complete Ollama base URL |
| `--ollama-api-key` | Ollama bearer token |
| `--print`, `-P` | Print mode |
| `--stream` | Stream print-mode response text |
| `--output-schema <json\|@file>` | Validate print-mode output against JSON Schema |
| `--permission <json>` | Tool policy for `agav run` |
| `--max-turns <number>` | Limit iterations in `agav run` |
| `--resume`, `-r [id]` | Open the session picker or resume by ID prefix |
| `--auto-accept`, `-y` | Skip normal tool confirmations |
| `--deny-writes` | Block write operations |
| `--sandbox-required` | Refuse to start without an OS-level sandbox |
| `--version`, `-v` | Print the version |
| `--help`, `-h` | Print help |

Both `--option value` and `--option=value` are accepted for provider, model, effort, Ollama values, output schema, permissions, and max turns.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic credential |
| `OPENAI_API_KEY` | OpenAI credential |
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
