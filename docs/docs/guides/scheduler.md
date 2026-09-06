---
title: Automate with Loops, Watch, and Schedules
description: Choose the smallest automation that matches a repeated task
guideLevel: advanced
order: 5
---

# Automate with Loops, Watch, and Schedules

Agav provides three session-based automation mechanisms. Agav must remain open for all three.

## Scenario: monitor hello-agav development

### Repeat an agent check

While working on a new feature, ask Agav to recheck the tests every 15 minutes:

```text
/loop 15m run the tests and report any failures with the relevant file and line
```

Stop it with `/loop stop`.

### React to module edits

The repository already has tests. Run the command once yourself, then watch the source files:

```text
/watch *.py python3 -m pytest tests/ -q
```

On Windows, use `python` instead of `python3` if that is how Python is installed. Stop the watcher with `/watch stop`. Watch commands run directly in your shell, so use only commands you trust.

### Save a timed review

Create a weekday morning prompt:

```text
/schedule add "0 9 * * 1-5" review counter.py and greeting.py for any TODO comments or missing error handling
```

Use `/schedule list`, then enable, disable, or remove a task by ID.

## Choose the right mechanism

| Need | Use |
| --- | --- |
| Repeat an agent prompt during this session | `/loop` |
| Run a command after a file changes | `/watch` |
| Save a cron prompt that runs while Agav is open | `/schedule` |
| Run after logout or in CI | An external scheduler with `agav run` or `agav -P` |

## Expected result

Development checks repeat at the right trigger without treating Agav as an unattended system service.

Next: [Use Memory Across Sessions](/guides/leverage-memory).
