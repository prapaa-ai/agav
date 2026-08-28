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
| `/schedule disable <id>` | Pause the scheduled task identified by `<id>`. |
| `/schedule enable <id>` | Resume the scheduled task identified by `<id>`. |
| `/schedule remove <id>` | Delete the scheduled task identified by `<id>`. |

Scheduled tasks use standard five-field cron expressions and persist in `~/.agav/scheduled-tasks.json`:

```text
/schedule add "0 9 * * 1-5" review open TODOs
/schedule list
/schedule disable <id>
/schedule enable <id>
/schedule remove <id>
```

Cron fields support wildcards (`*`), lists (`1,2,3`), ranges (`1-5`), and steps (`*/15`). `/schedule add` currently validates only that the cron has five fields, so malformed numeric values can still be saved but will never match. Task IDs can be given as full IDs or prefixes.

The scheduler checks enabled tasks only while Agav is running in the interactive UI. It polls every 30 seconds and runs matching tasks at most once per minute. It does not install an operating-system daemon, so Agav must be active when a schedule matches.

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
