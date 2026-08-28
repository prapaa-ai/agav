---
title: Planning and Steering
description: Structure longer work and redirect the agent without losing progress
order: 4
---

# Planning and Steering

## Plans

| Command or prompt | Intent |
| --- | --- |
| `plan: <request>` | Require Agav to create a structured plan before it starts the request. |
| `/plan` | Show this session's plan, its step states, and recorded verification commands. |
| `/plan list` | List every plan saved for the current project, across all sessions. |
| `/plan <n> <status>` | Manually set step `<n>` to `pending`, `in_progress`, `done`, or `failed`. |
| `/plan clear` | Remove this session's plan when it is no longer useful. |
| `no plan` or `skip plan` | Ask Agav to execute a request directly without creating a plan. |
| `Ctrl+G` | Toggle the plan detail panel to see descriptions and verify commands mid-run. |

Prefix a request with `plan:` to force a structured plan:

```text
plan: migrate the API client to the new authentication flow
```

Agav can also create a plan automatically for sufficiently complex refactors, migrations, or multi-phase work. Auto-generated plans usually contain 2 to 5 high-level steps. Plans are saved per-session under `.agav/plans/<sessionId>.json`, anchored at the repository root. Agav works one step at a time, with step states `pending`, `in_progress`, `done`, and `failed`.

Plans belong to the session that created them and survive restarts. Resume a session with `agav --resume <id>` to pick its plan back up. Use `/plan list` to see all plans saved for the current project. Stale plans are automatically pruned after 30 days.

`plan:` and `plan - ...` are explicit opt-ins. Agav also recognizes opt-outs such as `no plan`, `skip plan`, `don't plan`, `without a plan`, and `do not ... plan`. Use `/plan <n> <status>` to manually update a step, or press `Ctrl+G` to view the full plan detail panel.

## Steering

| Command | Intent |
| --- | --- |
| `/steer <directive>` | Add `<directive>` as session-scoped direction for the active task. |
| `/steer list` | Show the active steering directives. |
| `/steer remove <number>` | Remove the directive at `<number>`. |
| `/steer clear` | Remove every active steering directive. |

Steers add session-scoped direction to the active task without rewriting the original request:

```text
/steer preserve backward compatibility
/steer list
/steer remove 1
/steer clear
```

Use steering when constraints change mid-task, a deadline narrows the scope, or a subagent also needs the updated direction. Steers are included in subsequent agent and subagent prompts until removed. They are in-memory only: they are not written to disk or resumed in a later CLI process. Running bare `/steer` behaves like `/steer list`.

## Independent subagents

Agav may delegate self-contained work to parallel subagents. Each gets its own conversation context and the available tools, while confirmations remain visible in the main UI. Agav currently allows up to five concurrent subagents. Write-oriented subagents attempt to work in isolated Git worktrees and apply their changes back afterward; if the merge-back step fails, Agav reports a warning. See [plugins and subagents](/features/plugins-and-subagents) for details.
