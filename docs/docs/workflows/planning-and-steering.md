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
| `/steer <directive>` | Redirect the main agent, or only the inspected subagent, at its next safe step. |
| `/steer list` | Show the active steering directives. |
| `/steer remove <number>` | Remove the directive at `<number>`. |
| `/steer clear` | Remove every active steering directive. |

Steers redirect the active task within the same turn without rewriting the original request. Foreground main-agent directives can also be managed for subsequent turns:

```text
/steer preserve backward compatibility
/steer list
/steer remove 1
/steer clear
```

Use steering when constraints change mid-task or a deadline narrows the scope. It works during foreground turns and while attached to a live background worker, including after `/resume`. Delivery happens at the next safe step, not by interrupting a tool already executing.

From the overview, `/steer` targets the main agent. Open a live subagent inspector to target only that child, then return with **Tab** to steer the main agent again. Main-agent directives are **not inherited by children**, and child directives do not go to the parent or siblings. Skill executions do not support steering.

Foreground main-agent directives remain in memory for subsequent main-agent turns until removed; they are not restored as an active directive list in a later CLI process. Worker delivery instead uses a **durable, execution-bound inbox** for the selected recipient, not a saved list for future executions. In the foreground main view, bare `/steer` behaves like `/steer list`. Bare `/steer`, `list`, `remove`, and `clear` are unavailable while attached to a worker or in a subagent inspector. **Pause remains unsupported for worker-owned turns**; see [Detached sessions](/features/detached-sessions).

## Queued follow-up requests

Submit a new prompt with **Enter** while Agav is streaming, preparing a request, executing tools, or running a `!` shell command. Agav captures that request and its attachments, clears the submitted composer, and processes queued requests in submission order when the current work is idle. Non-mid-turn-safe slash commands queue too. A later draft and its attachments are preserved during handoff.

```text
Review the authentication flow.
# While Agav is working, submit:
Then add regression tests for the cases you found.
```

- Run `/queue` or press **Ctrl+Q** when entries are present to manage them. Select with **Up/Down**, cancel an entry with **Delete/Backspace**, or click its **×**.
- **Esc** or **Ctrl+Q** returns to the composer without cancelling the active turn or queued requests. Dispatch waits while queue management, a picker, or a confirmation is open.
- If dispatch throws or cannot start, the request returns to the front and the queue pauses. Resolve the blocker, then run `/queue retry`; the failed request retains its attachments.
- **Esc** outside a modal cancels the active work, not all queued entries. Cancel unwanted follow-ups individually before closing queue management.

Queuing is different from steering: `/steer` adds constraints to the current task, and `/ps <question>` runs an independent, tool-free side query. Allowed mid-turn commands still execute immediately when there are no pending attachments. While generation is paused, ordinary non-command input intervenes in the active turn instead of queuing, unless another submission is already being prepared.

## Independent subagents

Agav may delegate self-contained work to parallel subagents. Each gets its own conversation context and the available tools, while confirmations remain visible in the main UI. Agav currently allows up to five concurrent subagents. Write-oriented subagents attempt to work in isolated Git worktrees and apply their changes back afterward; if the merge-back step fails, Agav reports a warning. See [plugins and subagents](/features/plugins-and-subagents) for details.
