---
title: Automate with Loops, Watch, and Schedules
description: Choose the smallest automation that matches a repeated task
guideLevel: advanced
order: 5
---

# Automate with Loops, Watch, and Schedules

Agav provides three session-based automation mechanisms. The interactive UI must remain open for all three; detaching an agent turn does not keep these triggers running.

## Scenario: monitor hello-agav development

### Repeat an agent check

While working on a new feature, ask Agav to recheck the tests every 15 minutes:

```text
/loop 15m run the tests and report any failures with the relevant file and line
```

Stop future checks with `/loop stop`. See [Automation](/workflows/automation#repeat-a-prompt) for supported intervals and limits.

### React to module edits

On macOS or Linux, run the test command once yourself, then watch the Python files:

```text
/watch *.py python3 -m pytest tests/ -q
```

Stop the watcher with `/watch stop`. Watch commands run directly via `/bin/sh`, without the normal tool sandbox or confirmation. `/watch` cannot launch commands on native Windows; use `/loop` for repeated checks there, or use a Windows-native file watcher.

### Save a timed review

Create a weekday morning prompt in the machine’s local time:

```text
/schedule add "0 9 * * 1-5" review counter.py and greeting.py for any TODO comments or missing error handling
```

Use `/schedule list` to find the task ID. To move the review to 10 a.m. and change what it checks, update the existing task (replace `<id>` with the full ID or a unique prefix):

```text
/schedule update <id> --cron "0 10 * * 1-5" --prompt review counter.py and greeting.py for missing error handling
```

Use either flag on its own to change only the time or only the prompt. The task keeps its ID, display name, enabled or disabled state, creation time, and last-run time. You can also enable, disable, or remove it by ID. See [Automation](/workflows/automation#schedule-persistent-tasks) for the cron format and more examples.

## Choose the right mechanism

| Need | Use |
| --- | --- |
| Repeat an agent prompt during this session | `/loop` |
| Run a command after a file changes | `/watch` |
| Save a cron prompt that runs while Agav is open | `/schedule` |
| Run a scheduled shell command while Agav is closed | [Background job schedules](/features/background-jobs#recurring-schedules) with unattended evaluation configured |
| Run an agent prompt from CI | An external scheduler with `agav run` or `agav -P` |

## Expected result

Development checks repeat at the right trigger without treating Agav as an unattended system service.

Next: [Use Memory Across Sessions](/guides/leverage-memory).
