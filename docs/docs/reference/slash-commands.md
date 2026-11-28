---
title: Slash Commands
description: Complete reference for Agav interactive commands
order: 3
---

# Slash Commands

Type `/` in an interactive session to autocomplete commands. Run `/help` to see the commands loaded in the current session, or `/help <command>` for detailed usage. Skills and MCP servers can add commands at runtime, so they are not listed individually here.

## Dispatch while busy

Built-in commands are grouped by when they dispatch while Agav is streaming, executing tools, or otherwise doing in-flight work:

| Behavior | Commands |
| --- | --- |
| Immediate | `/help`, `/exit`, `/detach`, `/loop`, `/steer`, `/context`, `/status`, `/name`, `/copy`, `/export`, `/open`, `/debug`, `/changelog`, `/remember`, `/forget` |
| Immediate for specific forms | `/branch` (list only), `/agent` (status only), `/agents list`, `/history list` (no filters), `/search <query>`, `/search-history <query>`, `/memory list [--type <type>]`, `/memory path`, `/undo list`, `/plan`, `/plan list`, `/schedule list`, `/skills list`, `/skills info <name>`, `/mcp`, `/mcp list`, `/watch`, `/watch stop`, `/job list`, `/job poll <id>`, `/job log <id>`, `/job stop <id>`, `/job capabilities`, `/job schedule [list]`, `/workflows help`, `/workflows validate <name-or-file>`, `/workflows inbox [run-id]` |
| Other forms deferred until idle | `/clear`, `/new`, `/model`, `/effort`, `/permission`, `/resume`, `/history`, `/search`, `/search-history`, `/watch`, `/branch`, `/compact`, `/memory`, `/fast`, `/deep`, `/undo`, `/plan`, `/schedule`, `/job`, `/workflows`, `/skills`, `/agents`, `/agent`, `/mcp`, `/customize`, `/login`, `/logout` |
| Rejected while busy (never queued) | `/voice` |
| Immediate app handlers (outside the registry) | `/ps <question>`, `/queue`, `/queue retry`, `/notices` |

Dispatch is **argument-aware**. For example, `/undo list` can inspect the undo stack while working, but `/undo <n>` waits. `/history list` is immediate, but adding `--limit`, `--provider`, or `--model` queues it. All forms of `/model`, `/effort`, and `/permission` wait. Deferred commands show why they were queued and run in FIFO order when idle, even if submitted during a pause; they do not redirect the paused turn. Use `/queue` to open the request queue. `/queue retry` unblocks processing if the queue is paused after a failure. Immediate commands still enforce normal approval requirements; for example, `/job stop <id>` may require inline consent while busy.

Ordinary immediate slash dispatch requires **no pending attachments**. With attachments, the command follows normal request serialization instead. `/voice` requires an idle prompt without attachments and rejects busy submissions rather than opening the microphone later.

`/exit` works mid-turn: it cancels a foreground in-process turn, requests durable, generation-bound cancellation of a worker-owned turn, and stops the repeating `/loop` before closing the terminal UI. Worker cancellation is asynchronous and does not undo side effects. Only `/detach` or the configured detach shortcut intentionally exits while leaving the worker running. See [Detached sessions](/features/detached-sessions). For a foreground in-process turn, use **Esc** to cancel without leaving Agav instead. **Ctrl+C** exits unless an Agav text selection is active, in which case it copies the selection.

## Chat and models

| Command | Purpose |
| --- | --- |
| `/help [command]` | List available commands or show detailed usage for one command, including `/ps`. |
| `/help --search <query>` | Find loaded commands by a literal phrase in their name or description, ignoring case. |
| `/clear`, `/new` | Start a clean chat without deleting saved sessions. |
| `/model [name]` | Open the model picker or switch to a specific model. In the picker, press Ctrl+Y to copy the highlighted model ID or drag to copy selected text. Enter selects the model and switches provider when needed. |
| `/effort [minimal\|low\|medium\|high\|max]` | Show or set reasoning effort. |
| `/fast`, `/deep` | Switch to the current provider's fast or most capable model shortcut. Vertex AI `/deep` requires location `global`, `us`, or `eu`; regional locations are rejected without changing the model or location. |
| `/compact` | Summarize older conversation content to free context-window space. |
| `/context` | Show the estimated current context-window occupancy: a breakdown for the system prompt, tools, MCP tools, skills, and messages, with Used and Free totals. While a turn is running, it excludes in-flight output. Session totals are cumulative across requests and can exceed the context window. |
| `/context --json` | Return the same estimated occupancy as numeric JSON, without cumulative session totals. |
| `/status` | Show the full session ID and saved title when available, plus model, permissions, working directory, token usage, and any locally signed-in consumer account. |
| `/permission [ask\|auto-accept\|deny-writes]` | Show the current permission mode, or change it for this session. Run bare `/permission` to open an interactive picker. The chosen mode persists for the session and is restored when you resume it. Organization policy may enforce a stricter minimum that cannot be loosened. Interactive sessions only. See [Security → Permission modes](/reference/security#permission-modes). |
| `/export [json\|--full] [sanitize\|--sanitize] [--branch-only]` | Write the retained conversation to a timestamped Markdown or JSON file. Add `--branch-only` to export messages added to the active conversation branch, `--full` for complete retained tool text in Markdown, or `sanitize` for best-effort redaction. See [export details](/workflows/sessions-and-memory#export-a-conversation). |
| `/copy [N]` | Copy an assistant response to the clipboard. With no argument, it copies the most recent response that contains text; `/copy 2` copies the second-most-recent. `N` must be a positive integer, and it counts only responses with text, so turns that only call tools or contain blank text are skipped. |
| `/copy code [N] [--response M]` | Copy a fenced code block from the latest assistant response. Defaults to its first block. `--response M` takes the block from the Mth-most-recent response instead, numbered as in `/copy M`, so `/copy code 2 --response 3` copies the second block of the third-most-recent response. |
| `/voice` | Dictate an editable prompt with offline Agav-managed native transcription; offers verified setup downloads and an idle prompt without attachments. See [Voice Input](/features/voice-input). |
| `/ps <question>` | Run a brief independent side query with read-only conversation context, without interrupting the active main task. It cannot use tools or plugins. |

## Sessions and workflow

| Command | Purpose |
| --- | --- |
| `/resume [id]` | Open the saved/live session picker or resume one by ID or prefix match, including worker progress and pending approvals. An ambiguous prefix lists up to 10 matching IDs without loading a session. |
| `/history [list [--limit <count>] [--provider <name>] [--model <name>]]` | Browse saved sessions or list them in plain text. Filters match the exact provider and the full model ID (case-insensitive for the model); the limit applies after filtering. |
| `/detach` | Close the UI while the current worker-owned turn continues locally. Requires `backgroundJobsEnabled: true` before starting the task; the configurable `detachSession` shortcut (default Ctrl+D) also works at approval prompts. See [Detached sessions](/features/detached-sessions). |
| `/search [query]`, `/search-history [query]` | Search saved session messages, names, and titles. With no query, open the interactive history search. |
| `/name <title>` | Give the current session a descriptive name. |
| `/branch [name]` | List branches in the current session lineage, or fork the current conversation into a named branch. |
| `/plan` | Show this session's plan and step progress. |
| `/plan list` | List every plan saved for the current project. |
| `/plan <n> <status>` | Set step `<n>` to `pending`, `in_progress`, `done`, or `failed`. |
| `/plan clear` | Delete this session's plan. Use `no plan` in a prompt to skip automatic planning. |
| `/steer <directive>` | Redirect the main agent, or only the inspected subagent, at its next safe step in the same turn. Works while worker-attached, including after resume. Main directives are not inherited by children. Bare `/steer`, `list`, `remove <number>`, and `clear` manage foreground main directives only, not worker attachments or child inspectors. See [steering](/workflows/planning-and-steering#steering). |
| `/loop` | Show the active loop. `/loop <interval> <prompt>` repeats an agent prompt; intervals support `s`, `m`, and `h`. `/loop <prompt>` defaults to ten minutes, and `/loop stop` cancels it. The maximum interval is 2,147,483,647 ms (about 24.9 days). |
| `/schedule`, `/schedule list` | Open the schedule manager or list saved tasks. Use `/schedule add "<five-field cron>" <prompt>` to create a task, or `enable`, `disable`, or `remove` with a task ID to manage it. |
| `/schedule update <id> [--cron "<five-field cron>"] [--prompt <text>]` | Change the cron expression, prompt, or both. At least one flag is required. Use the full ID or a unique prefix; exact matches take precedence, and ambiguous prefixes are rejected. See [Automation](/workflows/automation#schedule-persistent-tasks) for examples. |
| `/job` | Open the background-jobs manager (requires `backgroundJobsEnabled`). Subcommands: `list`, `poll <id>`, `log <id> [--stderr] [--tail N]`, `stop <id>`, `schedule list\|create\|revoke`, `abandon <full-id> --acknowledge-unverified`, and `capabilities`. Abandoning releases capacity without confirming that the process stopped. In the manager, **D** (Delete stopped) opens a confirmation to delete finished jobs and eligible inactive schedules across both tabs. See [Background jobs](/features/background-jobs). |
| `/workflows` | Open the workflow manager. Use `/workflows help` for validation, launch, and run-management commands. Requires both workflow and background-job opt-ins; see [Workflow reference](/reference/workflows). |
| `/watch <path\|glob> <command>` | Run a command with `/bin/sh` on matching changes. Bare `/watch` shows status; `/watch stop` stops the watcher and clears any pending callback. Not a native Windows shell runner. |
| `/undo`, `/undo list`, `/undo <n>` | Revert the most recent tracked file change, list the undo stack, or revert only entry `<n>` from that list. Invalid arguments do not change files or consume an entry. |
| `/open [n]` | List registered session attachments or open or preview attachment number `<n>`. |

## Memory and skills

| Command | Purpose |
| --- | --- |
| `/memory`, `/memory list [--type user\|feedback\|project\|reference]` | Open the memory manager or print project memories, optionally filtered by type. |
| `/memory add <text>` | Save a persistent memory. |
| `/memory search <query>` | Show memories whose name, description, or content contains the query, ignoring case, with an excerpt of each match. |
| `/memory show <name>` | Show the complete memory by its exact stored name. |
| `/memory delete <name>`, `/memory rm <name>` | Delete one memory by its listed name. |
| `/memory rename <old-name> <new-name>` | Rename one memory by its listed name, keeping its type, description, and content. |
| `/memory clear`, `/memory path` | Delete all project memories or show their storage directory. |
| `/remember <text>` | Shortcut for `/memory add <text>`. |
| `/forget [name]` | List memories when called without an argument, or delete a memory by name. |
| `/skills`, `/skills list` | List bundled, global, and project skills. |
| `/skills info <name>` | Show a skill's origin, invocation mode, tool policy, path, and usage statistics. |
| `/skills add <path\|url>` | Validate and install a skill from a local `SKILL.md` or trusted URL. Restart Agav to activate it. |
| `/skills marketplace [number]` | List available marketplace skills or install a numbered entry. |
| `/skills remove <name>`, `/skills rm <name>` | Remove an installed global skill. Bundled and project skills can't be removed — Agav points you to `/skills disable` instead. Restart Agav to apply the change. |
| `/skills disable <name>` | Turn a skill off without deleting it. Works on bundled skills, which are compiled into the binary and cannot be removed. Restart Agav to apply. |
| `/skills enable <name>` | Turn a previously disabled skill back on. Restart Agav to apply. |
| `/skills clear` | Remove all user-installed (global) skills. Bundled and project skills are unaffected. Restart Agav to apply. |
| `/<skill-name> [arguments]` | Invoke an installed user-callable skill. The exact command name comes from the skill's slug. |

## Agents

| Command | Purpose |
| --- | --- |
| `/agents` | Open the agent management TUI. `[1]` List tab shows installed agents with credentials status, enable/disable toggle, and config editor, including native-tool selection for editable native agents. `[2]` Marketplace tab browses, searches, and installs community agents. `[3]` Create tab lists user-created agents and templates, and opens a 5-step wizard to create or edit agents. |
| `/agent [name]`, `/agent off` | Check, set, or clear the session’s named-agent lock. |

## MCP

| Command | Purpose |
| --- | --- |
| `/mcp`, `/mcp list` | Show connected servers and servers awaiting authentication. |
| `/mcp auth <name>`, `/mcp logout <name>` | Sign in explicitly to an MCP server or clear its cached local OAuth credentials. See [MCP](/features/mcp). |

Completed MCP tool results identify the server that supplied them.

## Appearance

| Command | Purpose |
| --- | --- |
| `/customize` | Open the customization interface to show, hide, and reorder footer (status bar) segments. Use the mouse wheel to move through entries, left-click an entry to open/select it, and left-click a checkbox to toggle it. Changes apply to the footer live and persist across sessions in the `statusBar` config field. Interactive terminal sessions only. |

## Account

| Command | Purpose |
| --- | --- |
| `/login` | Open the consumer Agav account wizard. Choose **Sign in with your Agav account** for browser authorization, or **Paste an Agav API key** for secure key entry. Never include the key as a slash-command argument. |
| `/logout --account` | Clear the local consumer account sign-in (`--consumer` is an alias). |
| `/login --auth-code`, `/login --device`, `/login --oidc`, `/login --saml` | Enroll in your organization. An explicit enterprise flag is required; `--control-plane`, `--issuer`, and `--client-id` also select enterprise enrollment. See [enterprise login options](/reference/cli#enterprise-login-subcommands). Restart Agav to apply the new policy. |
| `/logout` | Sign out of your organization and clear the cached enrollment. Restart Agav to apply. |

## Diagnostics and exit

| Command | Purpose |
| --- | --- |
| `/notices` | Read details of session errors and warnings shown in the footer. |
| `/debug` | Show conversation, plan, sandbox, token, plugin, MCP, undo, and memory state. |
| `/changelog [on\|off\|status]` | Show release notes from the latest update. Agav also shows the changelog automatically once on the first launch after an update. `/changelog off` stops that automatic display and `/changelog on` restores it; the choice persists across sessions. `/changelog status` reports the current choice without changing it or fetching notes. Bare `/changelog` shows the notes either way. |
| `/exit` | Save the current session and exit Agav. |

MCP prompts appear as additional slash commands supplied by their connected server. Project skills and user-installed skills likewise add commands after Agav restarts; use `/help` or type `/` to see what is available in the current session.
