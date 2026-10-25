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
| `agav --name <title>` | Start a new interactive session with an initial name. |
| `agav sessions delete <id>` | Delete a saved session by ID or unique prefix (alias: `rm`). |
| `/resume [id]` | List saved sessions, or resume one by ID or prefix match. |
| `/search <query>` | Find saved sessions that match `<query>`. |
| `/name <name>` | Give the active session a recognizable name. |
| `/clear` or `/new` | Start a clean chat while keeping saved sessions. |
| `/export [json] [sanitize\|--sanitize]` | Export the retained conversation as Markdown or JSON, optionally with best-effort redaction. |
| `/exit` | Save the current session and exit. |

Agav auto-saves interactive conversations after each completed turn under `~/.agav/history`.

> **Windows:** `~/.agav/` paths resolve to `%USERPROFILE%\.agav\`.

`agav --resume` opens a picker listing all saved sessions, with the total count shown in the header. You can move the selection with `↑/↓`, `j/k`, or the mouse wheel, or click a row to select it. Press `Enter` to resume the selected session, `D` to delete, `M` or `R` to rename, and `Esc` or `q` to cancel. In the rename view, type the new name and press `Enter` to save, or press `Esc` to cancel and return to the list without renaming.

Note: resuming a session created with `--max-turns` keeps the session's own history but the turn cap is reapplied to each new prompt.

`/resume` opens the same interactive picker in newest-first order. `/search` performs a case-insensitive substring search across saved message text and string tool results, returns up to 10 matching sessions, and shows up to 3 snippets per session. To reopen a result directly, use its ID prefix with `agav --resume <id-prefix>`.

## Export a conversation

```text
/export                  Markdown preview
/export json             Structured JSON
/export sanitize         Markdown with best-effort redaction
/export json sanitize    JSON with best-effort redaction
```

`sanitize` and `json` work in either order; `--sanitize` is an alias for `sanitize`.
Use `/help export` or `/export --help` for usage. Unknown options produce an error
without creating a file. While Agav is working, export waits in the existing
command queue until the agent is idle.

Files are saved in the working directory as `agav-export-<timestamp>.md` or `.json`.
Sanitized filenames include `-sanitized`. Existing files are never overwritten;
collisions get a numeric suffix. The command reports the saved path or a useful
failure message. New files request owner-only read/write permissions on POSIX;
this does not configure Windows ACLs. Empty or internal-only conversations do not
create files. Export never changes the active conversation or saved history.

Markdown retains the existing readable layout, with previews of tool inputs
(200 characters) and results (500 characters). JSON preserves the full retained
message structure, text, and tool activity without those additional preview limits.
Both exclude agent-injected internal prompts while preserving actual user messages.

Exports cover the **retained conversation**, not a complete session archive.
Context management may already have trimmed tool results or replaced old messages
with a summary. Export cannot recover discarded content; a known compaction is
reported in command feedback and JSON metadata. Expanded file attachments and
per-turn environment context may be present in JSON, even when the terminal shows
only a shorter display label.

### JSON format

The UTF-8 file is indented JSON with a trailing newline:

```json
{
  "schemaVersion": 1,
  "model": "example-model",
  "provider": "openai",
  "exportedAt": "2026-10-25T06:00:00.000Z",
  "scope": "retained-conversation",
  "compacted": false,
  "sanitized": false,
  "tokenUsage": {
    "inputTokens": 120,
    "outputTokens": 30,
    "cacheReadTokens": 10,
    "cacheWriteTokens": 2
  },
  "omissions": { "imagePayloads": 0, "providerMetadata": 0 },
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "Hello" }] }
  ]
}
```

- `model` and `provider` identify the current selection. `tokenUsage`, when
  available, contains tracked session totals, potentially spanning model switches
  and messages no longer retained. It is not usage per exported message. Missing
  usage is omitted, not estimated.
- `compacted` records known conversation compaction. `false` does not guarantee
  that no tool results have been trimmed.
- `messages` preserve order and roles, with `content` blocks for text, tool calls,
  tool results, and images. Tool call/result IDs, names, structured inputs, error
  flags, and nested `toolResultContent` are retained. Optional `displayText`,
  `sourceText`, and `invocationReason` describe presentation and invocation.
- Unsanitized JSON includes available base64 `imageData` and media/dimension
  metadata; image-heavy exports can be large. Sanitized JSON replaces image bytes
  with `imageDataOmitted: true`, retains media/dimension metadata, and reports the
  omitted payload count. Images are not reopened, uploaded or analyzed.
- Opaque provider replay metadata is excluded in either mode; `omissions.providerMetadata`
  counts blocks where it was removed. The file is for reading and processing, not
  a provider replay checkpoint or an import/resume guarantee.

### Sanitization limits

Sanitization runs locally before writing, across message text, display/source
text, nested tool inputs/results, and included textual metadata. The original
conversation remains unchanged, and no raw intermediate export is written.
The same rules apply to Markdown and JSON; Markdown redaction happens before
preview truncation.

Supported rules mask recognizable `sk-`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`
and `github_pat_` tokens (at least eight token characters after the prefix), bearer
credentials, and string values assigned to recognizable credential names such as
`apiKey`, `api_key`, `access_token`, `refresh_token`, `auth_token`, `token`, `password`,
`client_secret`, and `Authorization`. Common underscore-prefixed environment names
such as `OPENAI_API_KEY` are recognized too. The replacement is `***REDACTED***`.
Terminal presentation controls are removed before matching, and the current
user's home path is shortened to `~` at path boundaries, including Windows
separator and case variants. Ordinary long strings and hashes are not automatically
treated as secrets.

**Review before sharing.** This is a best-effort aid, not a guarantee: arbitrary
secrets, PII, encoded credentials, unsupported formats, secrets in object keys,
and other users' paths can remain. Object keys and non-string values are preserved.
Image contents cannot be inspected by text redaction, so image payloads are omitted
from sanitized JSON. A successful sanitized export does not certify that it is
safe to publish.

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
