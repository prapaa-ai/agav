---
title: Automate with Loops, Watch, and Schedules
description: Choose the smallest automation that matches a repeated task
guideLevel: advanced
order: 5
---

# Automate with Loops, Watch, and Schedules

Agav provides three session-based automation mechanisms. Agav must remain open for all three.

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

## Choose the right mechanism

| Need | Use |
| --- | --- |
| Repeat an agent prompt during this session | `/loop` |
| Run a command after a file changes | `/watch` |
| Save a cron prompt that runs while Agav is open | `/schedule` |
| Run after logout or in CI | An external scheduler with `agav run` or `agav -P` |

## Expected result

Tracker reviews repeat at the right trigger without treating Agav as an unattended system service.

Next: [Use Memory Across Sessions](/guides/leverage-memory).
