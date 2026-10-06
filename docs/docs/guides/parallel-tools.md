---
title: Run Tools in Parallel
description: Inspect independent parts of a repository at the same time
guideLevel: advanced
order: 1
---

# Run Tools in Parallel

Use parallel tools for short, independent checks that belong in the same conversation.

## Scenario: understand hello-agav before adding a feature

Before adding a new feature, you need to understand three separate parts of the project:

- how the CLI parses arguments and calls modules
- how the greeting is built
- how the run counter works

Ask Agav to inspect them together:

```text
Inspect these parts of the repository in parallel:

1. Read @main.py and list the CLI arguments and which modules they call.
2. Read @greeting.py and summarize the greeting format and parameters.
3. Read @counter.py and explain how the run counter is persisted to state.json.

Do not edit files. Combine the results into one short data-flow summary.
```

Agav can run independent reads and searches concurrently, then return the evidence to the same conversation.

## Keep dependencies in order

Do not parallelize steps when one changes what the next step reads. State the order explicitly:

```text
First update counter.py to add a history log. After that edit succeeds, inspect the updated module and run the tests.
```

Keep overlapping edits and state-changing commands sequential. A successful `edit_file` or `write_file` invalidates earlier verification. Tests or shell checks in the same parallel tool batch as that edit do not count as post-edit verification, even if their result arrives last. Wait for the edit batch to finish, then run checks in a later batch.

Independent checks against the same finished revision can run together. If any check in that batch fails, a passing sibling does not cancel the failure; fix the cause and verify again in a later batch. A `run_tests` result with no recognized passing tests is inconclusive, not proof that the change passed. Passing tests still do not replace any required build, manual run, warning review, or expected-output comparison. See [structured test runs](/features/built-in-tools#structured-test-runs-and-verification) for the exact behavior.

Tool results remain [bounded per result](/features/built-in-tools#output-limits-and-recovery) when run concurrently. Parallel reads can still add substantial aggregate context, and large simultaneous captures share the process's temporary-output retention budget. Prefer a focused `overview` depth, targeted searches, and file ranges; follow truncation notices when more evidence is needed.

Use [parallel subagents](/guides/parallel-agents) when each investigation is large enough to need its own context.

## Expected result

You get one concise map of the CLI arguments, greeting format, and counter persistence without waiting for each independent read in sequence.

Next: [Coordinate Parallel Subagents](/guides/parallel-agents).
