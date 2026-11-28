---
title: Troubleshooting
description: Diagnose provider, terminal, file context, MCP, and automation problems
order: 7
---

# Troubleshooting

## Agav is not found or runs an older version

Run `command -v agav` on macOS/Linux or `Get-Command agav -All` in PowerShell to see which copy your shell resolves. Check `agav --version` in a fresh terminal. The installer normally puts the command in `~/.local/bin` on macOS/Linux or `$env:LOCALAPPDATA\agav` in PowerShell. If that directory is missing from `PATH`, add it or invoke the binary by its full path. If a different installation comes first, fix the `PATH` order or remove the old copy.

For `(308) Permanent Redirect` in Windows PowerShell 5.1, use `https://www.agav.dev/install.ps1`. For a Windows executable that needs the baseline build (for example, after an update on a machine without AVX2), rerun the [PowerShell installer](/getting-started/installation#windows-powershell) rather than `agav update`. A release branch or its version badge is not proof that the binary has been published; check [Releases](https://github.com/prapaa-ai/agav/releases).

## No provider credentials found

Set the [credential for your chosen provider](/getting-started/providers) in the same shell that launches Agav. For example, use `export OPENAI_API_KEY="your-key"` on macOS/Linux or `$env:OPENAI_API_KEY = 'your-key'` in PowerShell. Vertex AI needs `VERTEX_AI_CREDENTIALS_PATH` pointing to a readable service-account JSON file; local Ollama needs a running server rather than a cloud key. If you pass `--provider`, Agav will not fall back to another provider.

Use the user config (`~/.agav/config.json`, or `$HOME\.agav\config.json` in PowerShell), not a repository config, for saved keys. If your user config still contains a legacy `keychain:` reference, re-enter the key or set the matching environment variable. Do not include credentials in diagnostics you share.

## No Ollama models found

Confirm the server is reachable and has a model:

```bash
ollama list
ollama pull llama3.2
agav --provider ollama --model llama3.2
```

Use `OLLAMA_ENDPOINT` for remote or hosted installations. If the server requires authentication, set `OLLAMA_API_KEY` and pass `--model` explicitly; automatic model discovery does not send that key. For errors from llama.cpp or LM Studio instead, see [local model troubleshooting](/getting-started/local-models#troubleshooting).

## A file mention is rejected

`@file` paths must stay inside the directory where Agav started. Start Agav higher in the repository, correct the relative path, or remove a symlink that resolves outside the workspace. A prompt can mention at most five unique files.

## A document preview is incomplete

Use `read_file` with a narrower line or page range. PDF and Office page requests return at most ten pages. Install LibreOffice or set `LIBREOFFICE_PATH` when Office conversion is unavailable.

## A shortcut does not work

Press the show-keybindings chord (default **Ctrl+K**, then **Ctrl+S**) and inspect global and project JSON overrides. Terminal encoding may collapse `Ctrl+M` into Enter or hide `Shift+Enter`; use `Ctrl+J` for a newline, or try `Option+Return` on macOS / `Alt+Enter` elsewhere if your terminal sends it.

## Interrupting a task exits Agav

Use **Esc** to cancel the current turn and stay in Agav. **Ctrl+C** with no Agav text selection exits; with a selection, it copies instead. In an actual `subagent` detail view, Esc targets that worker; skill and named-agent entries have no individual focused-cancel handler, so return to the overview before cancelling the parent; in a confirmation prompt, it denies that tool call. Close a picker or preview first if it consumes Esc. See [Keybindings](/reference/keybindings#cancel-versus-exit).

For worker-owned turns, interrupting requests durable, generation-bound cancellation; it does not synchronously kill execution. Use `/detach` or the configured detach shortcut (default Ctrl+D) to exit without requesting cancellation. See [Detached sessions](/features/detached-sessions#detach-versus-cancellation).

Cancellation preserves already-applied edits and external side effects. Review `git diff` before retrying. Retry backoff is cancellable, but custom tools must honor cancellation, MCP server work can continue, and Docker containers may need separate cleanup. See [cancellation limits](/reference/security#cancellation-is-not-isolation).

## Command output or file contents are truncated

Tool text is capped at **40,000 UTF-8 bytes and 2,000 lines**. A head/tail excerpt is not complete output. Follow the notice's saved log path with `read_file` line ranges, or follow its continuation range in the original file. A single enormous line needs targeted extraction rather than repeating the same range. There is no `max_output_chars` option to raise the cap.

Saved shell/HTTP logs hold at most **16 MiB**. Shell execution continues after the log fills; HTTP capture cancels the remaining body, so a partial HTTP log may not contain the response's final lines. Logs are temporary and normal exit attempts to remove them. Copy anything needed before leaving Agav.

If the notice reports storage or retention quota failure, omitted output may be unavailable. The tool's original status is preserved and it is not rerun automatically. Do not retry a side-effecting command or POST just to recover output; narrow a safe diagnostic query instead. See [Built-in Tools](/features/built-in-tools#output-limits-and-recovery) for recovery and retention details.

## A shell command or test is refused

Check `/debug` for the detected sandbox. macOS uses Seatbelt when available; Linux can use Bubblewrap (`bwrap`), which must be installed and usable on the host. On Windows, shell and test tools require the native sandbox helper by default. If it is missing, try the standalone release instead of a source checkout. The restricted-token backend does not provide network isolation and refuses commands under `sandboxNetwork: "deny"`. See [Sandboxing](/reference/security#shell-sandbox) for platform differences.

`run_command` uses `/bin/sh` on macOS/Linux and `cmd.exe` on native Windows, even if you started Agav in PowerShell. Use the command syntax for that runner; PowerShell scripts require starting PowerShell explicitly. `/watch` uses a separate `/bin/sh` runner and does not work on native Windows.

## A command hangs or a background job remains

Shell commands run without interactive stdin or a controlling terminal. Run password prompts, interactive Git/SSH commands, and terminal applications in your own shell. Command timeouts bound execution and inherited-pipe waits; cancellation attempts process-tree cleanup, but detached descendants and remote work may survive. Successful shell commands can leave background children under Seatbelt or the unsandboxed runner; Bubblewrap and the Windows sandbox terminate those descendants when the invocation ends. Jobs started through `run_background_job` have a separate lifecycle. A successful shell leader does not prove its background job finished; inspect or stop the service explicitly.

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

A `/schedule` task needs Agav running when the cron expression matches. For unattended prompts, invoke `agav run` or `agav -P` from an OS or CI scheduler. Recurring [background job schedules](/features/background-jobs#recurring-schedules) are separate and can use `agav job tick --install` or `agav job daemon start`.

## Terminal rendering is broken

Use a modern terminal with raw input and color support. Non-interactive environments should use `agav run` or `agav -P` instead of the Ink UI.

## Links show URLs or will not open

Terminal Markdown links intentionally display as `label (URL)` rather than OSC8 hyperlinks, including in Cursor and macOS Terminal. Bare URLs are shown once, and detected URL fragments remain clickable when wrapped. Click the visible URL, not just its descriptive label.

Agav tries `$BROWSER` first when configured, then the platform opener. On headless Linux without a display, the platform browser opener is unavailable; copy the URL into your local browser. If you still see garbled escape sequences in links, check that you are running an updated binary and report the terminal name and a minimal example.

## The startup logo looks wrong

The startup banner is static, not a thinking animation or an image-protocol asset. It uses a 12×5 braille shell on macOS/Linux and a 16×7 block-character shell on Windows. If you see boxes or uneven cells, try a monospace terminal font that supports those characters. The name, version, and tagline stack below the mark on narrow terminals; the thinking spinner is unchanged.

## Gather diagnostics

Run `/debug` to inspect provider state, model, effort, sandbox backend, loaded tools, plugins, MCP connections, context use, and token accounting.
