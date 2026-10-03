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
| `activate_skill` | Run a registered skill by name |

Connected MCP servers, installed plugins, and active skills can add more tools.

## Output limits and recovery

Tool text returned through Agav's registry is limited to **40,000 UTF-8 bytes and 2,000 lines**, including truncation notices. This also covers registered MCP, plugin, skill, and subagent results, errors, and text appended by hooks. Small results are unchanged. Oversized results normally keep a head/tail excerpt with an explicit omission notice; image blocks, error status, and structured result metadata are preserved. Text limits do not cap image token usage.

These are fixed implementation limits, not provider-token counts. There is **no `max_output_chars` parameter** on `run_command`, `read_file`, or `fetch_url`, and no configuration setting to raise these limits. Narrow the query or retrieve a specific saved section instead.

### Saved output paths and retention

When output is saved, the notice gives the actual absolute path. The layout is:

```text
<OS temp directory>/agav-output-v1-<uid-or-user>/slot-<n>/output-<random>/output.log
```

Agav writes `output.tmp` first and publishes `output.log` by atomic rename. On Unix, directories use mode `0700` and files use `0600`. Logs can contain private command output or API response data; private permissions are not encryption.

- Each saved file holds at most **16 MiB**. A partial-log notice means only a prefix was saved, not all omitted content.
- Each Agav process has a **128 MiB** retention budget, including reservations for unfinished writes, and at most **4,096 capture admissions**. Shell and HTTP captures reserve 16 MiB each while pending; publication releases unused reserved bytes.
- The per-user temporary root admits **32 process slots**, reserving up to **4 GiB** of payload capacity across processes sharing that root (plus metadata).
- Published logs are not evicted during a live process. Orderly process exit attempts to delete that process's slot, so these paths are not durable session-history attachments. Copy any log you need before exiting Agav.
- After a crash, a later startup or first capture can prune a slot only when its recorded creation time is at least **24 hours** old and its owner PID is confirmed dead. This is an opportunistic sweep, not a timer or guaranteed 24-hour deletion. Live or reused PIDs, denied probes, unsafe paths, and unknown ownership metadata are conservatively left alone.

If storage is full, unavailable, unsafe, or over quota, Agav returns a bounded warning rather than advertising a nonexistent log. Saving failure does not change the original tool's success/error status or rerun its side effects; omitted content may be unavailable.

Use the path in the notice with `read_file` and `start_line`/`end_line`, or `grep_search` with a targeted pattern. Recovery calls are bounded too. A saved “complete returned text” file contains what the tool returned, not data the tool already excluded or summarized. In particular, the test runner's raw diagnostic excerpt is not a complete test-process transcript.

## File reads and repository maps

### `read_file`

`path` can be absolute or relative to the working directory. Text ranges use **1-based, inclusive** `start_line` and `end_line`. If only `end_line` is provided, reading starts at line 1; if only `start_line` is provided, reading continues toward EOF until the output limit. Ends beyond EOF are clamped, while a start beyond EOF is an error. Invalid or reversed ranges are rejected.

Large text files are streamed rather than loaded in full. A bounded text read returns a contiguous prefix of the requested range, reserving room for headers and recovery instructions (at most 1,995 selected whole lines). Its continuation notice identifies the next `start_line` in the **original file**, preserving any requested `end_line`; no duplicate temporary copy is needed. Follow that notice rather than treating the returned excerpt as the whole file. If the first requested line alone is too long, Agav returns a bounded excerpt and recommends targeted byte extraction with `run_command`; repeating that same line range will not advance through the line.

PDF and Office ranges use 1-based, inclusive `start_page` and `end_page`, with at most **10 pages** per preview. Images do not accept line or page ranges, and PDF/Office documents do not accept line ranges. Office fallback behavior depends on available conversion tools: without LibreOffice, `.pptx` uses extracted slide text, while `.docx` uses extracted text without preserving page ranges or visual layout. See [files and context](/workflows/files-and-context) for attachment and preview requirements; `@file` attachment limits are separate from these tool-result limits.

### `overview`

`overview` returns a source-file and symbol skeleton, not file contents or a complete inventory of every file type. Use a project-relative `path` to focus on a subdirectory. `depth` counts subdirectories relative to that path:

| `depth` | Included source files |
| --- | --- |
| `0` | Files directly in the requested directory only |
| `1` | Those files plus files in immediate subdirectories |
| `2` or higher | Files through that many subdirectory levels |
| Omitted | Unrestricted depth, still subject to the file cap |

Depth must be a non-negative safe integer; invalid values fail before traversal. Hidden directories and common dependency, build, cache, and worktree directories are skipped. The map stops at **200 source files** and reports that it may be incomplete whenever the cap is reached, even if exactly 200 files exist. Narrow `path` or `depth` rather than assuming the first map covered the whole repository. Explicit shallow requests avoid reading deeper source files as well as returning their symbols.

## Structured test runs and verification

`run_tests` supports `pytest`, `vitest`, `jest`, `go`, and `cargo`. It detects the framework from the working directory, or accepts a `framework` override. `path` selects a test target, not a new working directory; Cargo treats it as a test-name filter. If detection fails, specify the framework or use `run_command` for the project's own test script.

The test process has a **120-second timeout** and a **1 MiB output-buffer limit**, separate from `run_command`'s streaming capture. Results show framework and actual test pass/fail counts, up to ten highlighted failures, and short traceback excerpts. Failed or inconclusive runs also show the last **2,000 characters** of raw output, plus any process error; this is not a full log.

Agav attaches structured verification metadata with `status`, `passed`, `failed`, `errors`, and `exitCode`:

| Status | Meaning |
| --- | --- |
| `passed` | Normal zero exit, positive recognized passing-test count, and no recognized failures/errors |
| `failed` | Nonzero exit, spawn/startup error, timeout/signal, or recognized test failures/errors — even if some tests passed |
| `inconclusive` | Zero exit but no recognized passing tests (for example, zero tests, skipped-only tests, or unrecognized output) |

`exitCode` is null when the process did not exit normally. JavaScript counts come from test summaries rather than suite/file counts; pytest counts come from its result summary rather than warning text; Cargo counts include all recognized suite summaries. An inconclusive result can be non-error, but it is **not evidence of successful verification**. Merely returning text such as “Passed: 10” without structured metadata is not enough either.

A passing `run_tests` in a **later tool batch** than a successful `edit_file` or `write_file` counts toward Agav's post-edit verification guard, avoiding redundant “you did not verify” requests. New successful edits invalidate earlier evidence. An edit and check in the same parallel batch do not establish post-edit verification, regardless of result order. Failure wins when multiple checks share a batch; a later passing batch can reverify. Existing shell-check recognition, permissions, hooks, and capped test-repair prompts remain in place; failed edit calls alone do not count as successful modifications, and hook output does not verify an edit.

Passing tests do not replace a task-required build, manual run, broader regression checks, warning review, or comparison against expected output. When output is truncated, retrieve the relevant saved sections or use a focused diagnostic command before concluding that warnings and errors are resolved.

### Context and cost

Bounded outputs and focused reads reduce oversized text sent back to the model, but recovery calls add context and may require further model requests. Agav's base instructions also consolidate repeated verification guidance without relaxing the requirements to test after edits, check regressions, build/run/check output, and investigate every warning. These changes do not alter model or effort defaults, remove tools, or change compaction behavior. Byte reductions and avoided redundant verification rounds are not guaranteed billing or throughput savings: tokenization, prompt caching, task scope, and follow-up retrieval all affect the result.

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
@counter.py find the increment function.
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

Shell commands have a 30-second default timeout and [bounded output](#output-limits-and-recovery). Agav auto-detects macOS Seatbelt or Linux Bubblewrap; Docker can be requested as a tool override.

`run_command` streams stdout/stderr, so a large output no longer fails merely by exceeding the old shell buffer. Small results show stdout followed by stderr; oversized results and saved logs use observed arrival order across the two streams. Above 40,000 decoded UTF-8 bytes (or when status/separator formatting crosses that limit), it saves a log and returns a Unicode-safe head/tail preview. The shared registry can additionally truncate results exceeding 2,000 lines.

The saved log stops at 16 MiB, but the command continues and its final output tail and exit status remain visible in the preview. A “partial output” notice therefore does not mean the command was stopped or that the log contains its final lines. Nonzero exits, signals, and timeouts remain errors even when stdout exists. Timeout handling attempts to terminate the process tree, escalates termination, and bounds pipe drainage rather than waiting indefinitely for inherited pipes. Storage failure does not rerun a command.

## HTTP responses

`fetch_url` supports GET (default), POST, PUT, DELETE, and PATCH, with optional headers and body. It streams the response as decoded text, including raw HTML, with a 30-second request timeout. Small results include the HTTP status and body unchanged; above **38,000 decoded UTF-8 bytes**, a response log and bounded head/tail preview are used.

Unlike shell capture, HTTP capture **cancels the remaining response** when its 16 MiB incoming-byte or decoded-storage limit is exceeded. The notice marks the saved response as partial; the preview tail is from the captured prefix, not necessarily the end of the server's body. Reaching this size limit alone does not turn a successful HTTP status into an error. Non-success HTTP statuses and network/stream-read failures do remain errors, with the captured status/body retained where available. Log-storage failures do not repeat the request or change HTTP success status. The [shared text limits and retention rules](#output-limits-and-recovery) apply to these results too.

## Sandbox backends

Each sandbox backend has different isolation properties:

| Backend | Filesystem writes | Network | Credential dirs |
| --- | --- | --- | --- |
| Seatbelt (macOS) | Allowed except `/System`, `/usr`, `/Library`, `/Applications` | Allowed | `~/.ssh`, `~/.aws`, `~/.gnupg` reads denied |
| Bubblewrap (Linux) | Read-only root, writable working directory and `/tmp` | Allowed | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config` masked |
| Docker | Mounted working directory only | Denied (`--network=none`) | Not mounted |

When no backend is available, the command runs unsandboxed with secret-like environment variables (`KEY`, `TOKEN`, `SECRET`, …) filtered out. Set `AGAV_NO_SANDBOX=1` to opt out of sandboxing deliberately. Review [security](/reference/security) before using auto-accept mode.
