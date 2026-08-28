---
title: Built-in Tools
description: Reference for the tools Agav can use inside a repository
order: 2
---

# Built-in Tools

Agav exposes these tools to its agent loop.

| Tool | Purpose |
| --- | --- |
| `read_file` | Read text ranges and preview images, PDFs, and Office documents |
| `write_file` | Create or replace a file |
| `edit_file` | Replace one exact, unique string in a file |
| `find_files` | Find names and glob matches |
| `grep_search` | Search file contents with regular expressions |
| `list_directory` | List a directory |
| `overview` | Map a repository's directory and symbol structure |
| `run_command` | Execute a shell command with sandbox detection |
| `run_tests` | Detect and run a supported project test framework |
| `lsp_query` | Request definitions, references, or hover data from a language server; diagnostic notifications are not yet fully surfaced |
| `read_notebook` | Read Jupyter notebook cells |
| `edit_notebook` | Change a notebook cell or its type |
| `web_search` | Search the web with DuckDuckGo |
| `fetch_url` | Send an HTTP request and return the response |
| `github` | Create or view GitHub pull requests and issues |
| `update_plan` | Update the active plan's current step |
| `save_memory` | Persist durable project or user context |
| `subagent` | Delegate an independent task |

Connected MCP servers, installed plugins, and active skills can add more tools.

## Language-server navigation

The `lsp_query` tool can find definitions, references, and hover information in TypeScript, JavaScript, Python, Rust, and Go projects when the matching language-server executable is available.

| Language | Executable |
| --- | --- |
| TypeScript or JavaScript | `typescript-language-server` |
| Python | `pylsp` |
| Rust | `rust-analyzer` |
| Go | `gopls` |

Ask Agav for semantic evidence explicitly when a text search is not enough:

```text
@scraper/__init__.py find the scraper registry.
Use definitions and references to trace where it is declared and called.
Explain the flow in execution order. Do not change files.
```

Agav combines language-server results with file reads and repository search. If the server is unavailable, confirm that its executable is on `PATH` in the shell that started Agav. Diagnostic notifications are not yet fully surfaced, so use the project's normal diagnostic command when complete output matters.

## Confirmations and undo

Writes, edits, and sensitive commands can display a confirmation prompt. Edit confirmations include a diff. Choosing the session-wide approval option releases queued confirmations as well.

Agav records prior content for tracked file edits in an in-memory undo stack:

```text
/undo list
/undo
```

The stack contains up to twenty changes and does not survive process exit. A newly created file has no previous content to restore.

## File boundaries

The file tools (`read_file`, `write_file`, `edit_file`) enforce path boundary checks. Writes are restricted to the working directory, temp directory, and `~/.agav/`. Reads are denied for credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube/config`). Writes to `.git/` and `.agav/` inside the project are always denied. See [security](/reference/security) for details.

## Shell execution

Shell commands have a 30-second default timeout and bounded output. Agav auto-detects macOS Seatbelt or Linux Bubblewrap; Docker can be requested as a tool override. The Seatbelt and Bubblewrap backends deny network access and restrict filesystem writes to the working directory. When no backend is available, the command runs unsandboxed with secret-like environment variables filtered out. Use `--sandbox-required` to refuse startup without a sandbox. Review [security](/reference/security) before using auto-accept mode.
