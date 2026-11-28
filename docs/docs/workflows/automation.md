---
title: Automation
description: Repeat prompts, schedule recurring tasks, and react to file changes
order: 5
---

# Automation

## Repeat a prompt

| Command | Intent |
| --- | --- |
| `/loop <interval> <prompt>` | Re-run a prompt in this session at the given interval. |
| `/loop <prompt>` | Start a loop using the default 10 minute interval. |
| `/loop stop` | Stop the active in-session loop. |

Use `/loop` for an in-session interval:

```text
/loop 5m check the latest logs and summarize new errors
/loop stop
```

Use a positive whole number with `s` (seconds), `m` (minutes), `h` (hours), or `d` (days). Without a suffix, the interval is in minutes. The maximum is **2,147,483,647 ms** (about 24.9 days); an interval above this limit is rejected without replacing the current loop. A valid new loop replaces the old one and first submits after one interval. `/loop` with no arguments shows the prompt, interval, tick count, and elapsed time. `/loop stop` stops future submissions; it does not cancel a turn already submitted. Loops stop when the interactive UI exits.

## Schedule persistent tasks

| Command | Intent |
| --- | --- |
| `/schedule` | Open the schedule manager (list tasks in headless mode). |
| `/schedule add "<cron>" <prompt>` | Save a recurring task using a five-field cron schedule. |
| `/schedule list` | Show saved scheduled tasks and their state. |
| `/schedule update <id> [--cron "<five-field cron>"] [--prompt <text>]` | Change an existing task's schedule, prompt, or both. |
| `/schedule disable <id>` | Pause the scheduled task identified by `<id>`. |
| `/schedule enable <id>` | Resume the scheduled task identified by `<id>`. |
| `/schedule remove <id>` | Delete the scheduled task identified by `<id>`. |

Scheduled tasks persist in `~/.agav/scheduled-tasks.json` (`%USERPROFILE%\.agav\scheduled-tasks.json` on Windows). Use `/schedule list` to find the ID of the task you want to update:

```text
/schedule add "0 9 * * 1-5" review open TODOs
/schedule list
/schedule update <id> --cron "0 10 * * 1-5"
/schedule update <id> --prompt summarize open TODOs by file
/schedule update <id> --cron "0 11 * * 1-5" --prompt summarize open TODOs by file
```

An update requires at least one of `--cron` or `--prompt`. Omit a flag to leave that value unchanged; an empty or whitespace-only prompt is rejected. Use the full ID or a unique prefix: an exact match takes precedence, and a prefix matching multiple tasks is rejected. Updating a task preserves its ID, display name, enabled or disabled state, creation time, and last-run time.

Quote the cron expression. Put `--prompt` last to enter free-form text without quotes. If `--prompt` comes first, quote its text (unquoted text before `--cron` is rejected): `/schedule update <id> --prompt "summarize open TODOs by file" --cron "0 11 * * 1-5"`.

Both `/schedule add` and `/schedule update` validate the complete cron expression before saving it: five fields in the order `minute hour day-of-month month day-of-week`, with valid field values, ranges, and steps. Fields support wildcards (`*`), lists (`1,2,3`), ranges (`1-5`), and steps (`*/15`). Wildcard steps in the day-of-month and month fields start at `1`, not `0`: `*/2` matches days 1, 3, 5, and so on, or months January, March, May, and so on.

The interactive scheduler polls every 30 seconds and checks for matches at most once per minute, using the machine’s local time. All five fields must match, including both day-of-month and day-of-week if both are restricted. `/schedule list` is available during a turn; updates and other changes wait until Agav is idle. `/schedule` never installs an operating-system daemon, so Agav must be active when one of these tasks matches.

To run shell commands on a schedule that keeps firing while Agav is closed, use [background jobs](/features/background-jobs#recurring-schedules) instead: they can be driven by `agav job tick --install` or `agav job daemon start`.

## Watch files

| Command | Intent |
| --- | --- |
| `/watch <path-or-glob> <command>` | Run `<command>` when matching files change. |
| `/watch` | Show the active watcher. |
| `/watch stop` | Stop the active watcher. |

On macOS and Linux, run a trusted, non-interactive shell command once before automating it. Then watch a directory or use a glob. The watch expression is one whitespace-delimited argument, so paths with spaces are not supported.

```text
/watch src npm run typecheck
/watch source/**/*.ts npm test
/watch
/watch stop
```

Only one watcher can be active. Changes are debounced by 300 ms. Stopping or replacing the watcher discards a pending callback, even if the replacement fails to start. It does not terminate commands already launched. Watcher events containing `node_modules`, `.git`, or `build/` in the reported filename are ignored. Commands run from Agav’s working directory with a 30-second timeout; non-empty output goes to stderr under `[AUTOMATION /watch]`. Watch mode ends when the UI exits.

Watch commands launch directly through `/bin/sh -c`, not through the `run_command` sandbox and confirmation flow. **Native Windows does not support this runner**; switching the Python executable name or launching Agav from PowerShell does not change it. Use `/loop` for repeated agent checks or a Windows-native file watcher for change-triggered checks. Use only trusted commands; avoid commands that deploy, modify data, or require interactive input.

For headless jobs, prefer [`agav run` or `agav -P`](/workflows/non-interactive) from your existing CI scheduler.
