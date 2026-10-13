---
title: Slash Commands
description: Complete reference for Agav interactive commands
order: 3
---

# Slash Commands

Type `/` in an interactive session to autocomplete commands. Run `/help` to see the commands loaded in the current session, or `/help <command>` for detailed usage. Skills and MCP servers can add commands at runtime, so they are not listed individually here.

Most slash commands run when Agav is idle. These commands can also run while Agav is streaming, executing tools, or otherwise doing in-flight work: `/help`, `/exit`, `/loop`, `/steer`, `/context`, `/memory`, `/remember`, and `/forget`.

Other commands, such as `/model` and `/clear`, are queued when submitted while a turn is busy and dispatched in submission order once Agav is idle. Ordinary prompts and `!` shell commands queue too, with their submitted attachments. `/queue` and `/queue retry` manage this queue immediately; `/ps <question>` still runs independently. While generation is paused, ordinary non-command input provides new direction for the active turn instead of queuing, unless another submission is already being prepared. Mid-turn command dispatch requires no pending attachments. See [queued follow-up requests](/workflows/planning-and-steering#queued-follow-up-requests).

`/exit` works mid-turn: it cancels the active turn and stops the repeating `/loop` before closing the terminal UI. To cancel without leaving Agav, use **Esc** instead. **Ctrl+C** exits unless an Agav text selection is active, in which case it copies the selection.

## Chat and models

| Command | Purpose |
| --- | --- |
| `/help [command]` | List available commands or show detailed usage for one command, including `/ps`. |
| `/clear`, `/new` | Start a clean chat without deleting saved sessions. |
| `/model [name]` | Open the model picker or switch to a specific model; Agav switches provider when needed. |
| `/effort [low\|medium\|high\|max]` | Show or set reasoning effort. |
| `/fast`, `/deep` | Switch to the current provider's fast or most capable model shortcut. |
| `/compact` | Summarize older conversation content to free context-window space. |
| `/context` | Show estimated context occupancy for the effective prompt, tools, and messages, separately from cumulative session usage; in-flight output is excluded while streaming. |
| `/copy [N]` | Copy the latest text-bearing assistant message, or the Nth-most-recent one (positive integer). Tool-only messages do not count. |
| `/export` | Write the current conversation, including tool activity, to a timestamped Markdown file in the working directory. |
| `/ps <question>` | Run a brief independent side query with read-only conversation context, without interrupting the active main task. It cannot use tools or plugins. |

## Sessions and workflow

| Command | Purpose |
| --- | --- |
| `/resume [id]` | Open the session picker or resume one by ID or prefix match. |
| `/history` | Open the searchable saved-session manager to inspect, rename, or delete sessions; use `/resume <id>` to load one. `/history list` prints a list. |
| `/search [query]`, `/search-history [query]` | Open the searchable history manager without arguments; with a query, print matching saved session messages. |
| `/queue` | Open queue management; use Up/Down to select, Delete/Backspace to cancel an entry, and Esc or Ctrl+Q to return. |
| `/queue retry` | Resume a queue paused after a dispatch failure, retrying the retained request first. |
| `/name <title>` | Give the current session a descriptive name. |
| `/branch [name]` | List branches in the current session lineage, or fork the current conversation into a named branch. |
| `/plan` | Show this session's plan and step progress. |
| `/plan list` | List every plan saved for the current project. |
| `/plan <n> <status>` | Set step `<n>` to `pending`, `in_progress`, `done`, or `failed`. |
| `/plan clear` | Delete this session's plan. Use `no plan` in a prompt to skip automatic planning. |
| `/steer <directive>` | Add in-memory, session-scoped direction for subsequent main-agent and subagent prompts. Use `/steer list`, `/steer remove <number>`, or `/steer clear` to manage directives. |
| `/loop` | Show the active loop. `/loop <interval> <prompt>` repeats an agent prompt; intervals support `s`, `m`, and `h`. `/loop <prompt>` defaults to ten minutes, and `/loop stop` cancels it. |
| `/schedule` | Open the searchable schedule manager to inspect, create, toggle, or delete tasks. `/schedule list` prints saved tasks; `add "<five-field cron>" <prompt>`, `enable`, `disable`, and `remove <id>` remain available. |
| `/watch <path\|glob> <command>` | Run a shell command after matching files change. `/watch stop` cancels it; glob patterns are supported. |
| `/undo`, `/undo list` | Revert the most recent tracked file change or inspect the current in-memory undo stack. |

## Memory and skills

| Command | Purpose |
| --- | --- |
| `/memory` | Open the searchable memory manager while idle to inspect, create, edit, or delete memories; falls back to a text list during a turn or without the interactive manager. |
| `/memory list` | Print project-scoped persistent memories. |
| `/memory add <text>` | Save a persistent memory. |
| `/memory delete <name>`, `/memory rm <name>` | Delete one memory by its listed name. |
| `/memory clear`, `/memory path` | Delete all project memories or show their storage directory. |
| `/remember <text>` | Shortcut for `/memory add <text>`. |
| `/forget [name]` | List memories when called without an argument, or delete a memory by name. |
| `/skills` | Open the searchable installed-skills manager with inspection, installation, enable/disable, and eligible global-skill deletion. |
| `/skills list` | Print bundled, global, and project skills. |
| `/skills info <name>` | Show a skill's origin, invocation mode, tool policy, path, and usage statistics. |
| `/skills add <path\|url>` | Validate and install a skill from a local `SKILL.md` or trusted URL. Restart Agav to activate it. |
| `/skills marketplace [number]` | Browse the marketplace manager without a number while idle; Enter/`i` inspects and `a` installs. In text-only contexts it prints entries; a number installs that entry. |
| `/skills remove <name>`, `/skills rm <name>` | Remove an installed global skill. Bundled and project skills can't be removed — Agav points you to `/skills disable` instead. Restart Agav to apply the change. |
| `/skills disable <name>` | Turn a skill off without deleting it. Works on bundled skills, which are compiled into the binary and cannot be removed. Restart Agav to apply. |
| `/skills enable <name>` | Turn a previously disabled skill back on. Restart Agav to apply. |
| `/skills clear` | Remove all user-installed (global) skills. Bundled and project skills are unaffected. Restart Agav to apply. |
| `/<skill-name> [arguments]` | Invoke an installed user-callable skill. The exact command name comes from the skill's slug. |

## Agents

| Command | Purpose |
| --- | --- |
| `/agents` | Open the agent management TUI. `[1]` List tab shows installed agents with credentials status, enable/disable toggle, and config editor, including native-tool selection for editable native agents. `[2]` Marketplace tab browses, searches, and installs community agents. `[3]` Create tab lists user-created agents and templates, and opens a 5-step wizard to create or edit agents. |

Bare resource-manager commands open a TUI only in an idle interactive session. Explicit `list` and other text subcommands remain available; see [sessions and memory](/workflows/sessions-and-memory), [skills](/features/skills), and [automation](/workflows/automation) for controls and text fallbacks.

## MCP connections

| Command | Purpose |
| --- | --- |
| `/mcp`, `/mcp list` | Show connected servers and those requiring authentication. |
| `/mcp auth <name>` | Explicitly start browser OAuth sign-in and reconnect the server without restarting. Startup never opens sign-in automatically. |
| `/mcp logout <name>` | Disconnect an OAuth server and remove cached local credentials and its session tools/resources/prompts. Provider grants are not revoked. |

See [MCP authentication](/features/mcp#oauth-authentication) for compatible servers, cancellation, and static-credential limitations.

## Diagnostics and exit

| Command | Purpose |
| --- | --- |
| `/debug` | Show conversation, plan, sandbox, token, plugin, MCP, undo, and memory state. |
| `/changelog` | Show release notes from the latest update. |
| `/exit` | Save the current session and exit Agav. |

MCP prompts appear as additional slash commands supplied by their connected server. Project skills and user-installed skills likewise add commands after Agav restarts; use `/help` or type `/` to see what is available in the current session.
