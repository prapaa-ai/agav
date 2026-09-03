---
title: Automate with Loops, Watch, and Schedules
description: Choose the smallest automation that matches a repeated task
guideLevel: advanced
order: 5
---

# Automate with Loops, Watch, and Schedules

Agav provides session-based automation mechanisms. Loops and watches stop when Agav exits. Schedule definitions persist, and scheduled background commands can start daemon-backed processes that continue after Agav exits.

## Scenario: monitor tracker work

### Repeat an agent check

While investigating generated data, ask Agav to recheck it every 15 minutes:

```text
/loop 15m inspect data/deprecations.json and report shutdowns in the next 60 days
```

Stop it with `/loop stop`.

### React to scraper edits

The repository already has checks. Run the command once yourself, then watch the scraper directory:

```text
/watch scraper python -m pytest -q
```

Stop it with `/watch stop`. Watch commands run directly in your shell, so use only commands you trust.

### Save a timed review

Create a weekday morning prompt:

```text
/schedule add "0 9 * * 1-5" review data/deprecations.json and summarize shutdowns in the next 30 days
```

Use `/schedule list`, then enable, disable, or remove a task by ID.

### Schedule a background command

For a command that should run without consuming an LLM turn, create a process schedule:

```text
/schedule background "0 9 * * 1-5" python -m pytest -q
```

Aliases are available when brevity reads better:

```text
/schedule bg "*/15 * * * *" npm run smoke
/schedule process "30 17 * * 5" node scripts/report.js
```

`/schedule list` marks these entries as `[process]` and shows `Command: ...`. When the cron matches, Agav starts a daemon-backed process directly. The process record and logs are stored under `~/.agav/background-processes/` unless `AGAV_BACKGROUND_PROCESS_DIR` is set, so the job can continue after Agav exits and report completion when Agav reattaches on restart.

## Choose the right mechanism

| Need | Use |
| --- | --- |
| Repeat an agent prompt during this session | `/loop` |
| Run a command after a file changes | `/watch` |
| Save a cron prompt that runs while Agav is open | `/schedule add` |
| Save a cron shell command that starts a daemon-backed job | `/schedule background`, `/schedule bg`, or `/schedule process` |
| Start one long-running command now | Ask Agav to use the `process` tool |
| Run after logout or in CI | An external scheduler with `agav run` or `agav -P` |

## Safety notes

- Scheduled prompt tasks submit text to the agent and follow normal tool permissions during that agent turn.
- Scheduled process tasks start the command directly at trigger time, without an LLM turn or confirmation prompt.
- Process jobs are daemon-backed and persist under `~/.agav/background-processes/` by default, but the schedule checker itself still requires an active Agav interactive UI when the cron matches.
- Background process commands are not routed through the normal `run_command` timeout and sandbox path. Use trusted, non-interactive commands.
- Use `AGAV_NODE=/path/to/node agav` if a packaged runtime needs a specific Node executable to host daemon runners.
- Use `AGAV_BACKGROUND_PROCESS_DIR=/path/to/jobs agav` when you need a custom directory for background process records and logs; use the same value after restart to reattach.

## Expected result

Tracker reviews repeat at the right trigger, and long commands can continue in the background without treating Agav's scheduler as an operating-system service.

Next: [Use Memory Across Sessions](/guides/leverage-memory), [Background Processes](/features/background-processes).
