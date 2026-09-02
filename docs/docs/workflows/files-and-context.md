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

For text files, `read_file` accepts absolute or relative file paths. Without a line range, text reads are limited to 1MB; ranged reads can still be truncated at 1MB with a warning.

LibreOffice improves Office handling when it is installed locally, and you can point Agav to it with `LIBREOFFICE_PATH`. Legacy `.doc` and `.ppt` files require LibreOffice. Without LibreOffice, `.docx` and `.pptx` fall back to text extraction only; `.pptx` keeps slide-based ranges, but `.docx` does not preserve page ranges or layout. Vision content is useful only when the selected model can process images.

## Paste content

Large text pastes become numbered attachments so the prompt stays readable. Text of roughly 50 or more characters is converted into a pasted attachment; shorter text stays inline. Paste an image from the clipboard to attach it when the terminal and operating system integration supports clipboard image extraction. Clipboard images are currently saved under `.agav/images/` in the working directory and rely on macOS clipboard helpers such as `pngpaste` or `osascript`. Backspace immediately after an attachment label removes it before submission.

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
