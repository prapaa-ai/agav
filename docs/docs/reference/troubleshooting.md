---
title: Troubleshooting
description: Diagnose provider, terminal, file context, MCP, and automation problems
order: 7
---

# Troubleshooting

## No API key found

Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`; set `VERTEX_AI_CREDENTIALS_PATH` to a service-account JSON file for Vertex AI; or run Ollama and select it explicitly. If you pass `--provider`, Agav requires that provider's credential instead of falling back to another configured provider.

## No Ollama models found

Confirm the server is reachable and has a model:

```bash
ollama list
ollama pull llama3.2
agav --provider ollama --model llama3.2
```

Use `OLLAMA_ENDPOINT` for remote or hosted installations.

## A file mention is rejected

`@file` paths must stay inside the directory where Agav started. Start Agav higher in the repository, correct the relative path, or remove a symlink that resolves outside the workspace. A prompt can mention at most five unique files.

## A document preview is incomplete

Use `read_file` with a narrower line or page range. PDF and Office page requests return at most ten pages. Install LibreOffice or set `LIBREOFFICE_PATH` when Office conversion is unavailable.

## A shortcut does not work

Run the show-keybindings chord and inspect global and project JSON overrides. Terminal encoding may collapse `Ctrl+M` into Enter or hide `Shift+Enter`; try `Option+Return` on macOS or `Alt+Enter` elsewhere.

## Interrupting a task exits Agav

Use **Esc** to cancel the current turn and stay in Agav. **Ctrl+C** with no Agav text selection exits; with a selection, it copies instead. In an actual `subagent` detail view, Esc targets that worker; skill and named-agent entries have no individual focused-cancel handler, so return to the overview before cancelling the parent; in a confirmation prompt, it denies that tool call. Close a picker or preview first if it consumes Esc. See [Keybindings](/reference/keybindings#cancel-versus-exit).

Cancellation preserves already-applied edits and external side effects. Review `git diff` before retrying. Retry backoff is cancellable, but custom tools must honor cancellation, MCP server work can continue, and Docker containers may need separate cleanup. See [cancellation limits](/reference/security#cancellation-is-not-isolation).

## Command output or file contents are truncated

Tool text is capped at **40,000 UTF-8 bytes and 2,000 lines**. A head/tail excerpt is not complete output. Follow the notice's saved log path with `read_file` line ranges, or follow its continuation range in the original file. A single enormous line needs targeted extraction rather than repeating the same range. There is no `max_output_chars` option to raise the cap.

Saved shell/HTTP logs hold at most **16 MiB**. Shell execution continues after the log fills; HTTP capture cancels the remaining body, so a partial HTTP log may not contain the response's final lines. Logs are temporary and normal exit attempts to remove them. Copy anything needed before leaving Agav.

If the notice reports storage or retention quota failure, omitted output may be unavailable. The tool's original status is preserved and it is not rerun automatically. Do not retry a side-effecting command or POST just to recover output; narrow a safe diagnostic query instead. See [Built-in Tools](/features/built-in-tools#output-limits-and-recovery) for recovery and retention details.

## A command hangs or a background job remains

Shell commands run without interactive stdin or a controlling terminal. Run password prompts, interactive Git/SSH commands, and terminal applications in your own shell. Command timeouts bound execution and inherited-pipe waits; cancellation attempts process-tree cleanup, but detached descendants and remote work may survive. Successful background jobs are deliberately preserved on successful completion. A successful shell leader does not prove its background job finished; inspect or stop the service explicitly.

## A repository map seems incomplete

`overview` maps source files and symbols, not every file. It stops at 200 source files. Ask for a narrower path and explicit depth: `0` is root files only, `1` includes immediate subdirectories, and omitted depth is unrestricted. A cap notice means the map may be incomplete. See [repository maps](/features/built-in-tools#overview).

## Tests passed but Agav asks for more verification

A passing recognized `run_tests` result counts after a successful edit only when it runs in a later tool batch. Zero-test, skipped-only, unrecognized, timed-out, or failed runs do not establish verification. An edit and tests in the same parallel batch are not post-edit evidence; later edits require new checks. Passing tests also do not replace a required build, manual check, or warning review. Ask Agav to run a focused check after the final edit; see [verification status](/features/built-in-tools#structured-test-runs-and-verification).

## A running skill seems idle or tokens have not updated

Tool-activated skills appear in the worker overview; select one with **↑ / ↓**, then **Enter** to inspect it. Manual-only skills open their details directly. The panel retains up to ten recent tool actions, not a complete transcript. Reasoning appears only when the provider emits it, and token usage updates only as usage events arrive; no event does not mean no billed usage. Reported partial usage remains after failure or interruption.

Manual-only slash-command skills receive neither a turn cancellation signal nor an interactive approval handler: in `ask` mode sensitive operations are refused and shell blocks are skipped. The detail panel itself is not an approval prompt. See [Skills](/features/skills#watch-a-running-skill).

## An MCP server is missing

Check its command and arguments outside Agav, then inspect `/debug`. MCP startup failures are non-fatal, and configuration changes require a restart.

## A scheduled task did not run

Agav must be running when the cron expression matches. For unattended scheduling, invoke `agav run` or `agav -P` from the operating system or CI scheduler.

If a `/schedule background`, `/schedule bg`, or `/schedule process` entry did not start, run `/schedule list` and confirm it is enabled and marked `[process]`. Prompt schedules are marked `[prompt]` and submit text to the agent instead of starting a command directly.

## A background process did not report completion

Background process records and logs are stored in `~/.agav/background-processes/` unless `AGAV_BACKGROUND_PROCESS_DIR` was set before Agav started. Ask Agav to list or poll jobs:

```text
Use the process tool to list all background jobs.
Use the process tool to poll job <id>.
Use the process tool to show logs for job <id>.
```

Completion notifications are emitted only by the interactive UI. If Agav was closed when the job finished, restart Agav in the project with the same `AGAV_BACKGROUND_PROCESS_DIR` value, if any, and wait a few seconds for reattach polling. A completed record with `notifiedAt` has already been reported and will not notify again on later restarts.

If jobs never leave `starting`, the daemon runner may not have a usable Node executable. Set `AGAV_NODE` to an absolute Node.js path and start Agav again:

```bash
AGAV_NODE=/usr/local/bin/node agav
```

If you used a custom process directory, inspect that directory for the job JSON and logs:

```bash
AGAV_BACKGROUND_PROCESS_DIR=/tmp/agav-bg agav
```

## A background process command was blocked

`process start` refuses commands that match Agav's destructive-command blocklist, such as `git reset --hard`. In `ask` mode, `process start` and `process kill` require confirmation unless an `allowedTools` rule applies. `process list`, `process poll`, `process log`, and `process wait` are treated as safe.

## Terminal rendering is broken

Use a modern terminal with raw input and color support. Non-interactive environments should use `agav run` or `agav -P` instead of the Ink UI.

## Links show URLs or will not open

Terminal Markdown links intentionally display as `label (URL)` rather than OSC8 hyperlinks, including in Cursor and macOS Terminal. Bare URLs are shown once, and detected URL fragments remain clickable when wrapped. Click the visible URL, not just its descriptive label.

Agav tries `$BROWSER` first when configured, then the platform opener. On headless Linux without a display, the platform browser opener is unavailable; copy the URL into your local browser. If you still see garbled escape sequences in links, check that you are running an updated binary and report the terminal name and a minimal example.

## The startup logo looks wrong

The startup banner is a static 12×5 Unicode braille shell mark, not a thinking animation or an image-protocol asset. Use a terminal font with braille glyph support if it displays boxes or uneven cells. The name, version, and tagline stack below the mark on narrow terminals; the thinking spinner is unchanged.

## Gather diagnostics

Run `/debug` to inspect provider state, model, effort, sandbox backend, loaded tools, plugins, MCP connections, context use, and token accounting.
