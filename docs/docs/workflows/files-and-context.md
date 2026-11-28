---
title: Files and Context
description: Attach files, documents, images, and pasted content to Agav prompts
order: 2
---

# Files and Context

## Mention files in prompts

| Command or syntax | Intent |
| --- | --- |
| `@<path>` | Attach a cwd-relative file or directory to the prompt. |
| `@"<path with spaces>"` | Attach a cwd-relative path whose name contains spaces. |
| `@@` | Enter a literal `@` without triggering a file mention. |

Use cwd-relative `@file` references in interactive prompts, `/ps` queries, and non-interactive modes:

```text
Compare @src/config.ts with @"docs/config reference.md".
```

Agav resolves `@mentions` within the current working directory only. Absolute paths are rejected, and paths cannot escape through `..` or symlinks. Agav supports at most five unique resolved paths per prompt; mentioning the same file more than once still counts as one attachment. Type `@@` for a literal `@`.

Text files are included directly when they are small enough. If a mentioned text file exceeds 500 lines or 100KB, Agav replaces the full contents with a structure outline and warning instead of silently flooding model context. In the terminal UI, `@` paths support Tab completion, including directory completion with a trailing `/`.

Directory mentions are supported through `@mentions` only, not through `read_file`. Directory context is non-recursive: Agav inspects immediate files only, includes at most 20 files, and shows at most 100 lines per text file.

## Documents and images

The `read_file` tool and file mentions understand:

- text files, with optional inclusive line ranges
- images, returned as compressed visual previews
- PDFs, with inclusive page ranges of up to ten pages
- Word and PowerPoint documents (`.doc`, `.docx`, `.ppt`, `.pptx`)

For text files, `read_file` accepts absolute or relative paths and inclusive, one-based `start_line` and `end_line` bounds. Omit `encoding` for default UTF-8 detection, or specify `utf-8`, `utf-16le`, `utf-16be`, or `latin1`. Large reads return a bounded excerpt and, when possible, the next line to read in the original file. See [Tool output limits](/features/built-in-tools#output-limits-and-recovery).

LibreOffice improves Office handling when it is installed locally, and you can point Agav to it with `LIBREOFFICE_PATH`. Legacy `.doc` and `.ppt` files require LibreOffice. Without LibreOffice, `.docx` and `.pptx` fall back to text extraction only; `.pptx` keeps slide-based ranges, but `.docx` does not preserve page ranges or layout. Vision content is useful only when the selected model can process images.

## Explore a repository without attaching files

These are agent tools, not slash commands. Ask Agav to use them when you want a narrower view than an attachment:

- `overview`: set `include_symbols: false` to map source paths without opening files for symbol extraction. Set `include_hidden: true` to include hidden source paths.
- `find_files`: set `relative_paths: true` for paths relative to the search root, or `max_results` to change the result cap. `list_directory` can filter by `type` (`files` or `directories`) and show dot-prefixed entries with `include_hidden: true`.
- `grep_search`: use `fixed_strings: true` for literal text, `ignore_case: true` for case-insensitive matching, and `exclude` for a basename glob. Use `context_before` and `context_after` for nearby lines or `max_results` to change the match cap.
- `read_notebook`: select an inclusive one-based cell range with `start_cell`/`end_cell` and filter by `cell_type` (`code`, `markdown`, or `raw`). For source only, set `include_outputs: false`.

See [Built-in Tools](/features/built-in-tools#file-reads-and-repository-maps) for limits and options.

## Paste content

Large text pastes become numbered attachments so the prompt stays readable. Text of 50 or more characters is converted into a pasted attachment; shorter text and single-line HTTP(S) URLs stay inline. Pasted line endings are normalized so multiline text keeps its separate lines.

Paste the same text again immediately, without editing the prompt, to expand the latest attachment into editable text. The “paste again to expand” hint appears only while that action is available. Expansion opens at the beginning of the pasted text; use **↑/↓** to navigate its visual rows. Long input scrolls with the caret and shows the visible row range, so you can inspect and edit the full paste. Editing the prompt clears repeat-paste eligibility; pasting again then creates a new attachment.

Paste an image from the clipboard to attach it when the terminal and operating system integration supports clipboard image extraction. Clipboard images are saved under `.agav/images/` in the working directory and rely on platform clipboard helpers: on macOS, `pngpaste` or `osascript`; on Linux, `wl-paste` (Wayland) or `xclip` (X11). On native Windows, save the image as a local file and attach it with `@<path>` instead. Use `/open` to list registered session attachments and `/open <n>` to open or preview one. Backspace immediately after an attachment label removes it before submission.

## Run a shell command

At the Agav prompt, `! <command>` runs a command directly from the working directory, shows the raw output, and submits the command and output to the agent for analysis. Use it only for commands you intend to run yourself: unlike the `run_command` tool, it runs outside the tool sandbox and inherits your environment.

Agav uses `/bin/sh` for direct commands on macOS and Linux and `cmd.exe` on native Windows, even when you launched it from PowerShell. The `run_command` tool also uses the backend’s shell, not your interactive shell. For example, to display a local log:

| Where you type | Command |
| --- | --- |
| Agav prompt on macOS/Linux | `! cat error.log` |
| Agav prompt on native Windows | `! type error.log` |
| Windows PowerShell, outside Agav | `Get-Content -Raw -Encoding UTF8 .\error.log` |

## Ask a side question

| Command | Intent |
| --- | --- |
| `/ps <question>` | Start a short, independent background question without blocking the active task. |
| `/ps @<path> <question>` | Ask an independent question with a specific local file attached. |
| `/steer <directive>` | Change the active task instead of asking an independent side question. |

Use `/ps` for a small, independent question while the main agent is working:

```text
/ps @package.json what is the build command?
```

`/ps` supports the same `@mention` expansion as a normal prompt and receives the active conversation as read-only context. It still runs as one separate provider call rather than through the main agent loop: it cannot use tools, plugins, MCP servers, skills, or project instructions. Attach a file when the side question needs exact local context. Its answer is intentionally brief, usually one to three sentences.

Use `/steer` instead when the new information should change the active task. Use a normal follow-up when the question depends on the shared conversation or needs a detailed answer.
