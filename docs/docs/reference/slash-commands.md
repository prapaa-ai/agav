---
title: Slash Commands
description: Complete reference for Agav interactive commands
order: 3
---

# Slash Commands

Type `/` in an interactive session to autocomplete commands. Run `/help` to see the commands loaded in the current session, or `/help <command>` for detailed usage. Skills and MCP servers can add commands at runtime, so they are not listed individually here.

## Chat and models

| Command | Purpose |
| --- | --- |
| `/help [command]` | List available commands or show detailed usage for one command, including `/ps`. |
| `/clear`, `/new` | Start a clean chat without deleting saved sessions. |
| `/model [name]` | Open the model picker or switch to a specific model; Agav switches provider when needed. |
| `/effort [low\|medium\|high\|max]` | Show or set reasoning effort. |
| `/fast`, `/deep` | Switch to the current provider's fast or most capable model shortcut. |
| `/compact` | Summarize older conversation content to free context-window space. |
| `/context` | Show a token-use breakdown for the system prompt, tools, MCP tools, skills, and messages. |
| `/export` | Write the current conversation, including tool activity, to a timestamped Markdown file in the working directory. |
| `/ps <question>` | Run a brief independent side query with read-only conversation context, without interrupting the active main task. It cannot use tools or plugins. |

## Sessions and workflow

| Command | Purpose |
| --- | --- |
| `/resume [id]` | List saved sessions or resume one by ID or prefix match. |
| `/search <query>` | Search saved session messages by keyword. |
| `/name <title>` | Give the current session a descriptive name. |
| `/branch [name]` | List branches in the current session lineage, or fork the current conversation into a named branch. |
| `/plan` | Show this session's plan and step progress. |
| `/plan list` | List every plan saved for the current project. |
| `/plan <n> <status>` | Set step `<n>` to `pending`, `in_progress`, `done`, or `failed`. |
| `/plan clear` | Delete this session's plan. Use `no plan` in a prompt to skip automatic planning. |
| `/steer <directive>` | Add durable direction for later turns. Use `/steer list`, `/steer remove <number>`, or `/steer clear` to manage directives. |
| `/loop` | Show the active loop. `/loop <interval> <prompt>` repeats an agent prompt; intervals support `s`, `m`, and `h`. `/loop <prompt>` defaults to ten minutes, and `/loop stop` cancels it. |
| `/schedule` | List saved tasks. Use `/schedule add "<five-field cron>" <prompt>` for agent prompts, or `/schedule background "<five-field cron>" <command>` for daemon-backed shell commands. Aliases: `/schedule bg` and `/schedule process`. Use `enable`, `disable`, or `remove <id>` to manage tasks. |
| `/watch <path\|glob> <command>` | Run a shell command after matching files change. `/watch stop` cancels it; glob patterns are supported. |
| `/undo`, `/undo list` | Revert the most recent tracked file change or inspect the current in-memory undo stack. |

### Schedule syntax

```text
/schedule list
/schedule add "0 9 * * 1-5" review open TODOs
/schedule background "0 9 * * 1-5" pnpm test
/schedule bg "*/15 * * * *" npm run smoke
/schedule process "30 17 * * 5" node scripts/report.js
/schedule disable <id>
/schedule enable <id>
/schedule remove <id>
```

`/schedule add` creates a `[prompt]` task. `/schedule background`, `/schedule bg`, and `/schedule process` create `[process]` tasks that start daemon-backed commands directly, without an LLM turn at trigger time. `/schedule list` shows `Prompt: ...` for prompt schedules and `Command: ...` for process schedules. Schedule definitions persist in `~/.agav/scheduled-tasks.json`; scheduled process logs and job records use `~/.agav/background-processes/` unless `AGAV_BACKGROUND_PROCESS_DIR` is set.

## Memory and skills

| Command | Purpose |
| --- | --- |
| `/memory`, `/memory list` | List project-scoped persistent memories. |
| `/memory add <text>` | Save a persistent memory. |
| `/memory delete <name>`, `/memory rm <name>` | Delete one memory by its listed name. |
| `/memory clear`, `/memory path` | Delete all project memories or show their storage directory. |
| `/remember <text>` | Shortcut for `/memory add <text>`. |
| `/forget [name]` | List memories when called without an argument, or delete a memory by name. |
| `/skills`, `/skills list` | List bundled, global, and project skills. |
| `/skills info <name>` | Show a skill's origin, invocation mode, tool policy, path, and usage statistics. |
| `/skills add <path\|url>` | Validate and install a skill from a local `SKILL.md` or trusted URL. Restart Agav to activate it. |
| `/skills marketplace [number]` | List available marketplace skills or install a numbered entry. |
| `/skills remove <name>`, `/skills rm <name>` | Remove an installed global skill. Restart Agav to apply the change. |
| `/skills clear` | Remove all user-installed (global) skills. Bundled and project skills are unaffected. Restart Agav to apply. |
| `/<skill-name> [arguments]` | Invoke an installed user-callable skill. The exact command name comes from the skill's slug. |

## Agents

| Command | Purpose |
| --- | --- |
| `/agents` | Open the agent management TUI. `[1]` List tab shows installed agents with credentials status, enable/disable toggle, and config editor. `[2]` Marketplace tab browses, searches, and installs community agents. `[3]` Create tab lists user-created agents and templates, and opens a 4-step wizard to create or edit agents. |

## Diagnostics and exit

| Command | Purpose |
| --- | --- |
| `/debug` | Show conversation, plan, sandbox, token, plugin, MCP, undo, and memory state. |
| `/changelog` | Show release notes from the latest update. |
| `/exit` | Save the current session and exit Agav. |

MCP prompts appear as additional slash commands supplied by their connected server. Project skills and user-installed skills likewise add commands after Agav restarts; use `/help` or type `/` to see what is available in the current session.
