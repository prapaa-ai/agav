---
title: Sessions and Memory
description: Resume conversations, branch investigations, compact context, and preserve project knowledge
order: 3
---

# Sessions and Memory

## Saved sessions

| Command | Intent |
| --- | --- |
| `agav --resume` | Open an interactive picker for a saved session at startup. |
| `agav --resume <id>` | Resume the saved session whose ID starts with `<id>`. |
| `/resume [id]` | List saved sessions, or resume one by ID or prefix match. |
| `/search <query>` | Find saved sessions that match `<query>`. |
| `/name <name>` | Give the active session a recognizable name. |
| `/clear` or `/new` | Start a clean chat while keeping saved sessions. |
| `/export` | Export the active conversation as Markdown. |
| `/exit` | Save the current session and exit. |

Agav auto-saves interactive conversations after each completed turn under `~/.agav/history`.

`agav --resume` opens a picker with up to 20 recent sessions. You can navigate with `↑/↓` or `j/k`, press `Enter` to resume, `D` to delete, `M` or `R` to rename, and `Esc` or `q` to cancel.

`/resume` lists the 10 most recent sessions in newest-first order. `/search` performs a case-insensitive substring search across saved message text and string tool results, returns up to 10 matching sessions, and shows up to 3 snippets per session. To reopen a result directly, use its ID prefix with `agav --resume <id-prefix>`.

## Fork a conversation with `/branch`

| Command | Intent |
| --- | --- |
| `/branch` | List branches in the active conversation's lineage. |
| `/branch <name>` | Fork the active conversation, save the fork as `<name>`, and switch to it. |

Use a branch when you want to explore a different solution without losing the current conversation. The new conversation keeps the context up to the fork point, then develops independently.

```text
/branch try-postgres
```

`/branch <name>` saves a fork from the active conversation and switches to it. Run bare `/branch` to list branches in the current conversation lineage. Unrelated saved sessions are not included; use `/resume` for those.

A practical pattern is to branch before a risky refactor, compare the result with the original approach, and resume whichever conversation you want to continue.

## Context compaction

| Command | Intent |
| --- | --- |
| `/compact` | Summarize older conversation context now to make room for continued work. |
| `/context` | Show a token breakdown for system prompt, tools, skills, MCP, and messages. |

Agav automatically compacts long histories and preserves a summary of important decisions, paths, bugs, and preferences. Run `/compact` to force compaction. Use `/context` for a real context-window breakdown. When a compaction summary exists, press `Ctrl+O` in the UI to show or hide it.

## Project memory

| Command | Intent |
| --- | --- |
| `/remember <text>` | Save `<text>` as a durable project memory. |
| `/memory list` | List the project's saved memories. |
| `/memory add <text>` | Save `<text>` as a project memory. |
| `/memory delete <memory name>` | Remove the saved memory named `<memory name>`. |
| `/memory path` | Show the active project's memory directory. |
| `/forget` | List the saved memories. |
| `/forget <memory name>` | Remove the saved memory named `<memory name>`. |
| `/memory clear` | Remove every memory for the active project. |

Memories persist facts that should survive sessions, such as user preferences, corrections, project decisions, and references. They are scoped by Git repository root when available, otherwise by the current working directory. Agav stores them under `~/.agav/projects/<hash>/memory/` and injects them into the system prompt on later turns.

```text
/remember Use pnpm for this repository.
/memory list
/memory add The API response shape is externally versioned.
/forget
/forget <memory name>
```

The model can also call `save_memory` when it detects durable context. Replace `<memory name>` with the name shown by `/forget` or `/memory list`; for example, `/forget prefer-pnpm`. Use `/memory clear` only when you intend to remove all memories for the project.
