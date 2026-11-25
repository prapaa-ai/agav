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

Supported interval suffixes are `s`, `m`, and `h`. If you omit a suffix, Agav assumes minutes. Only one loop is active at a time, and starting a new loop replaces the old one. `/loop` with no arguments shows the current prompt, interval, tick count, and elapsed time. Loops stop when the session exits.

## Schedule persistent tasks

| Command | Intent |
| --- | --- |
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

An update requires at least one of `--cron` or `--prompt`. Omit a flag to leave that value unchanged. Use the full ID or a unique prefix: an exact match takes precedence, and a prefix matching multiple tasks is rejected. Updating a task preserves its ID, enabled or disabled state, creation time, and last-run time.

Quote the cron expression. Put `--prompt` last to enter free-form text without quotes. If `--prompt` comes first, quote its text: `/schedule update <id> --prompt "summarize open TODOs by file" --cron "0 11 * * 1-5"`.

Both `/schedule add` and `/schedule update` validate the complete cron expression before saving it: five fields in the order `minute hour day-of-month month day-of-week`, with valid field values, ranges, and steps. Fields support wildcards (`*`), lists (`1,2,3`), ranges (`1-5`), and steps (`*/15`). Wildcard steps in the day-of-month and month fields start at `1`, not `0`: `*/2` matches days 1, 3, 5, and so on, or months January, March, May, and so on.

The scheduler checks enabled tasks only while Agav is running in the interactive UI. It polls every 30 seconds and runs matching tasks at most once per minute. `/schedule` never installs an operating-system daemon, so Agav must be active when one of these tasks matches.

To run shell commands on a schedule that keeps firing while Agav is closed, use [background jobs](/features/background-jobs#recurring-schedules) instead: they can be driven by `agav job tick --install` or `agav job daemon start`.

## Watch files

| Command | Intent |
| --- | --- |
| `/watch <path|glob> <command>` | Run `<command>` when files under the path or glob change. |
| `/watch` | Show the active watcher. |
| `/watch stop` | Stop the active watcher. |

Run a trusted, non-interactive shell command once before automating it. Then watch a path or glob:

```text
/watch src npm run typecheck
/watch source/**/*.ts npm test
/watch
/watch stop
```

Only one watcher can be active; starting another replaces it. Changes are debounced by 300ms. Changes under `node_modules`, `.git`, and `build` are ignored. Watched commands run with a 30 second timeout and write output to stderr with a `[watch]` prefix. Watch mode ends when Agav exits.

Watch commands currently launch directly through `/bin/sh -c` rather than through the normal `run_command` sandbox and confirmation flow, so configure only commands you trust. Avoid commands that deploy, modify data, or require interactive input.

For headless jobs, prefer [`agav run` or `agav -P`](/workflows/non-interactive) from your existing CI scheduler.
