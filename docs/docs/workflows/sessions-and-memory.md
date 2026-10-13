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
| `/resume [id]` | Open the session picker, or resume one by ID or prefix match. |
| `/history` | Open the saved-session manager (text list without an interactive app). |
| `/history list` | Print saved sessions as text, even in interactive mode. |
| `/search` or `/search-history` | Open the searchable saved-session manager in the interactive app. |
| `/search <query>` or `/search-history <query>` | Print saved-message search results as text. |
| `/name <name>` | Give the active session a recognizable name. |
| `/clear` or `/new` | Start a clean chat while keeping saved sessions. |
| `/export` | Export the active conversation as Markdown. |
| `/exit` | Save the current session and exit. |

Agav auto-saves interactive conversations after each completed turn under `~/.agav/history`.

`agav --resume` opens a picker listing all saved sessions, with the total count shown in the header. You can move the selection with `↑/↓`, `j/k`, or the mouse wheel, or click a row to select it. Press `Enter` to resume the selected session, `D` to delete, `M` or `R` to rename, and `Esc` or `q` to cancel. In the rename view, type the new name and press `Enter` to save, or press `Esc` to cancel and return to the list without renaming.

Note: resuming a session created with `--max-turns` keeps the session's own history but the turn cap is reapplied to each new prompt.

`/resume` opens the same interactive picker in newest-first order. The separate `/history` and bare `/search` (alias `/search-history`) commands open resource managers for browsing and inspecting saved sessions; `Enter` inspects a session rather than resuming it. To load a session, close the manager and use `/resume <id-prefix>` or `agav --resume <id-prefix>`.

### Inspect and search saved sessions

The history and search-history managers share these controls:

| Control | Action |
| --- | --- |
| `↑/↓` or mouse wheel | Select a session. |
| `←/→` | Move between pages; the footer shows the current page and total. |
| `Enter` or `i` | Inspect saved message text and tool results; `↑/↓` scrolls the detail view. |
| `b` or `Esc` in details | Return to the list. |
| `s` | Start incremental, case-insensitive substring filtering across titles, metadata, and saved message/tool-result text. Typing or pasting updates the filter and resets pagination. |
| `Enter` while searching | Finish editing the search while keeping its filter. |
| `r` | Refresh saved sessions. |
| `e` | Edit the selected session's name; `Enter` saves, `Esc` cancels. |
| `d` | Request deletion; `y` confirms, `n` or `Esc` cancels. |
| `Esc` in the list | Clear an active search/filter first; press again to exit. |

These managers support rename and confirmed deletion, not session creation or enable/disable toggles. Unsupported actions are hidden and ignored. The managers are available only through the idle interactive app hook, not headless execution or during an active turn. `/history list` always returns text; without the interactive hook, bare `/history` also lists sessions and bare `/search` or `/search-history` prints query usage.

With a query, `/search <query>` and `/search-history <query>` retain their textual behavior even in the interactive app: a case-insensitive substring search across saved message text and string tool results, up to **10 matching sessions** and **3 snippets per session**. This text-result cap is separate from the manager's paginated filtering.

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
| `/context` | Estimate current context-window occupancy and separately show cumulative session token usage. |

Agav automatically compacts long histories and preserves a summary of important decisions, paths, bugs, and preferences. Run `/compact` to force compaction. Use `/context` for an **estimated effective context-window occupancy**, not a provider-measured exact count or the sum of all tokens billed over the session. The breakdown covers the effective system prompt, non-MCP tool schemas, MCP tool schemas, and committed conversation messages. MCP tools are identified by server metadata, not just their name prefix.

Once the stable per-turn prompt has been captured, it includes project instructions, memories, and the skill catalog; `/context` labels this row **System prompt + skills** and counts embedded skills only once. Before that prompt is available (for example, before the first turn or after clearing the conversation), it uses the configured or base prompt estimate and shows a separate skills estimate, with a notice that stable per-turn context has not yet been captured.

During a running turn, the snapshot **excludes in-flight output**; streamed text is not yet committed conversation context. The separate **Session totals (all requests, not context occupancy)** section reports cumulative input, output, cache-read, and, when nonzero, cache-write tokens. Those totals can greatly exceed one context window and are not the basis of the Used/Free occupancy estimate. When a compaction summary exists, press `Ctrl+O` in the UI to show or hide it.

## Project memory

| Command | Intent |
| --- | --- |
| `/memory` | Open the interactive memory manager (text list without an interactive app or during a turn). |
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

### Inspect and edit memories

Bare `/memory` opens the shared manager in the idle interactive app. `/memory list` and bare `/forget` always print text, even in interactive mode; during a running turn or without the interactive app hook, bare `/memory` also falls back to the text list.

Use the same navigation, pagination, incremental search, inspection, refresh, and `Esc` behavior described above. Memory search includes names, descriptions, and full content. Available actions are `n` to create, `e` to edit, and `d` to request confirmed deletion; memories do **not** have an enable/disable toggle. Forms contain name, description, type (`user`, `feedback`, `project`, or `reference`), and content. Use `Tab` or `↑/↓` to move between fields, `Enter` to validate and save, or `Esc` to cancel without writing. Names must be lowercase hyphenated slugs, descriptions must be one line, and editing must keep the existing name unchanged.

The model can also call `save_memory` when it detects durable context. Replace `<memory name>` with the name shown by `/forget` or `/memory list`; for example, `/forget prefer-pnpm`. Use `/memory clear` only when you intend to remove all memories for the project.
