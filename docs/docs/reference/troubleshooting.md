---
title: Troubleshooting
description: Diagnose provider, terminal, file context, MCP, and automation problems
order: 7
---

# Troubleshooting

## No API key found

Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`; set `VERTEX_AI_CREDENTIALS_PATH` to a service-account JSON file for Vertex AI; or run Ollama and select it explicitly. If you pass `--provider`, Agav requires that provider's credential instead of falling back to another configured provider.

## No Ollama models found

Confirm the server is reachable and has a model:

```bash
ollama list
ollama pull llama3.2
agav --provider ollama --model llama3.2
```

Use `OLLAMA_ENDPOINT` for remote or hosted installations.

## A file mention is rejected

`@file` paths must stay inside the directory where Agav started. Start Agav higher in the repository, correct the relative path, or remove a symlink that resolves outside the workspace. A prompt can mention at most five unique files.

## A document preview is incomplete

Use `read_file` with a narrower line or page range. PDF and Office page requests return at most ten pages. Install LibreOffice or set `LIBREOFFICE_PATH` when Office conversion is unavailable.

## A shortcut does not work

Run the show-keybindings chord and inspect global and project JSON overrides. Terminal encoding may collapse `Ctrl+M` into Enter or hide `Shift+Enter`; try `Option+Return` on macOS or `Alt+Enter` elsewhere.

## An MCP server is missing

Check its command and arguments outside Agav, then inspect `/debug`. MCP startup failures are non-fatal, and configuration changes require a restart.

## A scheduled task did not run

Agav must be running when the cron expression matches. For unattended scheduling, invoke `agav run` or `agav -P` from the operating system or CI scheduler.

## Terminal rendering is broken

Use a modern terminal with raw input and color support. Non-interactive environments should use `agav run` or `agav -P` instead of the Ink UI.

## Gather diagnostics

Run `/debug` to inspect provider state, model, effort, sandbox backend, loaded tools, plugins, MCP connections, context use, and token accounting.
