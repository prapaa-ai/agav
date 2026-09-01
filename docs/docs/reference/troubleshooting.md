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

If a `/schedule background`, `/schedule bg`, or `/schedule process` entry did not start, run `/schedule list` and confirm it is enabled and marked `[process]`. Prompt schedules are marked `[prompt]` and submit text to the agent instead of starting a command directly.

## A background process did not report completion

Background process records and logs are stored in `~/.agav/background-processes/` unless `AGAV_BACKGROUND_PROCESS_DIR` was set before Agav started. Ask Agav to list or poll jobs:

```text
Use the process tool to list all background jobs.
Use the process tool to poll job <id>.
Use the process tool to show logs for job <id>.
```

Completion notifications are emitted only by the interactive UI. If Agav was closed when the job finished, restart Agav in the project with the same `AGAV_BACKGROUND_PROCESS_DIR` value, if any, and wait a few seconds for reattach polling. A completed record with `notifiedAt` has already been reported and will not notify again on later restarts.

If jobs never leave `starting`, the daemon runner may not have a usable Node executable. Set `AGAV_NODE` to an absolute Node.js path and start Agav again:

```bash
AGAV_NODE=/usr/local/bin/node agav
```

If you used a custom process directory, inspect that directory for the job JSON and logs:

```bash
AGAV_BACKGROUND_PROCESS_DIR=/tmp/agav-bg agav
```

## A background process command was blocked

`process start` refuses commands that match Agav's destructive-command blocklist, such as `git reset --hard`. In `ask` mode, `process start` and `process kill` require confirmation unless an `allowedTools` rule applies. `process list`, `process poll`, `process log`, and `process wait` are treated as safe.

## Terminal rendering is broken

Use a modern terminal with raw input and color support. Non-interactive environments should use `agav run` or `agav -P` instead of the Ink UI.

## Gather diagnostics

Run `/debug` to inspect provider state, model, effort, sandbox backend, loaded tools, plugins, MCP connections, context use, and token accounting.
