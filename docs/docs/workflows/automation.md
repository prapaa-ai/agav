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
| `/schedule add "<cron>" <prompt>` | Save a recurring agent prompt using a five-field cron schedule. |
| `/schedule background "<cron>" <command>` | Save a recurring daemon-backed shell command. Aliases: `/schedule bg`, `/schedule process`. |
| `/schedule list` | Show saved scheduled tasks and their state. |
| `/schedule disable <id>` | Pause the scheduled task identified by `<id>`. |
| `/schedule enable <id>` | Resume the scheduled task identified by `<id>`. |
| `/schedule remove <id>` | Delete the scheduled task identified by `<id>`. |

Scheduled tasks use standard five-field cron expressions and persist in `~/.agav/scheduled-tasks.json`:

```text
/schedule add "0 9 * * 1-5" review open TODOs
/schedule background "0 9 * * 1-5" pnpm test
/schedule bg "*/15 * * * *" npm run smoke
/schedule process "30 17 * * 5" node scripts/report.js
/schedule list
/schedule disable <id>
/schedule enable <id>
/schedule remove <id>
```

`/schedule add` creates a `[prompt]` task that submits text to the agent when it matches. `/schedule background`, `/schedule bg`, and `/schedule process` create a `[process]` task that starts a daemon-backed background command directly, without waiting for the LLM. `/schedule list` shows `Prompt: ...` for prompt tasks and `Command: ...` for process tasks.

Cron fields support wildcards (`*`), lists (`1,2,3`), ranges (`1-5`), and steps (`*/15`). Schedule creation currently validates only that the cron has five fields, so malformed numeric values can still be saved but will never match. Task IDs can be given as full IDs or prefixes.

The scheduler checks enabled tasks only while Agav is running in the interactive UI. It polls every 30 seconds and runs matching tasks at most once per minute. It does not install an operating-system daemon, so Agav must be active when a schedule matches. Once a scheduled process starts, the daemon-backed job itself persists after Agav exits; job records and logs live in `~/.agav/background-processes/` unless `AGAV_BACKGROUND_PROCESS_DIR` is set, and completion is reported in the main chat when Agav reattaches.

## Start a background process on demand

Ask Agav to use the `process` tool when a long command should run in the background:

```text
Use the process tool to start this in the background: node -e "setTimeout(() => console.log('done'), 15000)"
```

Then ask for status or logs:

```text
Use the process tool to list all background jobs.
Use the process tool to poll job <id>.
Use the process tool to show logs for job <id>.
Use the process tool to wait up to 30 seconds for job <id>.
Use the process tool to kill job <id>.
```

Supported process actions are `start`, `list`, `poll`, `log`, `wait`, and `kill`. Model-initiated `process start` and `process kill` calls ask for confirmation in normal `ask` mode; the `process start` prompt warns that daemon jobs can continue after Agav exits and consume resources. Background jobs write records and captured stdout/stderr logs under the Agav config directory at `~/.agav/background-processes/` by default, continue after Agav exits, and reattach on restart with a one-time completion notification in the main chat. Set `AGAV_BACKGROUND_PROCESS_DIR` before starting Agav to use a different job directory, and set `AGAV_NODE=/path/to/node` if a packaged runtime needs a specific Node executable for daemon runners. See [Background Processes](/features/background-processes) for the full tool reference and permission behavior.

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
