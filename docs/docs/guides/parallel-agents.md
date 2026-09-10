---
title: Coordinate Parallel Subagents
description: Split a larger review into independent investigations
guideLevel: advanced
order: 2
---

# Coordinate Parallel Subagents

Use subagents when independent investigations need more context than a few tool calls.

## Scenario: audit every module in hello-agav

The project has separate modules for CLI parsing, greeting logic, and counter persistence. They can be reviewed independently, then compared for consistency.

```text
Audit the hello-agav modules with three parallel subagents:

- Review @main.py for argument handling, error paths, and missing edge cases.
- Review @greeting.py for format correctness, locale issues, and untested inputs.
- Review @counter.py for race conditions, file corruption, and error handling when state.json is malformed.

Each subagent must:
- read only its assigned module and the relevant tests
- report bugs, risks, and missing test coverage
- cite file paths and line numbers
- make no edits

After they finish, combine the findings into one prioritized report.
```

Each assignment includes its files, checks, output, and no-edit constraint because subagents work independently and cannot ask follow-up questions.

## Review the combined result

Use `↑` / `↓` to select a subagent and `Enter` to inspect it. Press `Esc` in the detail view to cancel the focused subagent, or `Tab` to return to the overview without cancelling. Sensitive confirmations still appear in the main terminal.

When all workers finish, ask the main agent to resolve disagreements and remove duplicate findings. Delegate edits only when workers own different files; worktrees reduce interference but do not make overlapping changes safe.

## Expected result

You receive three bounded audits and one reconciled list of risks across main.py, greeting.py, and counter.py, while the main conversation retains final ownership.

Next: [Run Tools in Parallel](/guides/parallel-tools).
