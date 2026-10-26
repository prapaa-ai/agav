---
title: Detached sessions
description: Leave an interactive task running locally, resume its progress, and answer pending approvals
order: 8
---

# Detached sessions

**Detach** closes the terminal UI without cancelling the interactive task that its worker is executing. The worker keeps the conversation, model loop, and pending tool approvals alive on your machine. Return later with `agav --resume <session-id>` to see progress or answer an approval.

This is different from simply saving a conversation: a saved transcript preserves history, while a detached session has a live process continuing the current turn. It is also different from a [background job](/features/background-jobs), which runs a shell command such as a dev server or watcher rather than an agent conversation.

## Enable before starting a task

Merge this setting into `~/.agav/config.json`, then start Agav:

```json
{ "backgroundJobsEnabled": true }
```

The default is `false`. Enable it **before submitting the task**; `/detach` does not migrate an already-running in-process turn into a worker. See [Configuration](/reference/configuration) for config precedence and Windows paths.

With the flag enabled, ordinary interactive prompts start execution in a supervised worker after initial preparation, even while you are still watching the terminal. Detaching disconnects that presentation; it does not restart the task or run a second copy. Initial context and plan preparation happen before worker ownership is established, so wait for the detach hint to appear.

## Detach and return

1. Start `agav` in your project and submit an ordinary task, for example: “Investigate the failing build and propose a fix.”
2. Once the worker is ready, type `/detach`, or press **Ctrl+X**. Agav exits the UI and prints:

   ```text
   Session <session-id> continues in the background.
   To resume: agav --resume <session-id>
   ```

3. Keep that ID. From your shell, return with the printed command, replacing `<session-id>` with the actual ID:

   ```bash
   agav --resume <session-id>
   ```

You can also run `agav --resume` to open the picker at startup, or `/resume` inside Agav. `/resume <id>` selects a session directly; ID prefixes are supported, but the full printed ID avoids choosing the wrong session.

**Ctrl+X works at a worker's approval prompt too.** It leaves the request pending; it is not Yes, No, or Always. Use it when the confirmation owns input and you cannot type `/detach`. **Ctrl+Q is not detach**: it opens the request queue when requests are queued, or exits while idle with an empty prompt.

Detaching continues the **current worker-owned turn**, not an unattended stream of future chat requests. Do not rely on unsent drafts or requests waiting in the terminal's queue being executed after the UI closes.

## Status and session management

The resume picker includes live runtimes as well as saved conversations, even before their first completed-turn history save. Runtime rows display the state and pending approval count, for example `[needs-approval · 1 pending]`.

| State | Meaning |
| --- | --- |
| `starting` | Worker execution is being established. |
| `running` | The worker is executing the turn. |
| `needs-approval` | One or more operations are waiting for your decision. |
| `completed` | The turn finished. Resume to review it or submit another prompt. |
| `failed` | Execution failed; resume to inspect the recorded conversation and error. |
| `interrupted` | Execution ended without recording normal completion. |
| `cancelled` | A terminal cancellation state, if present. |

Select with **↑/↓**, **j/k**, the mouse wheel, or a click; press **Enter** to resume. **M** or **R** renames both active and terminal sessions. Enter saves the new name; Esc cancels renaming. **D** deletes saved conversations and terminal runtimes only; deletion is unavailable for `starting`, `running`, and `needs-approval` sessions. Deleting history is not a way to stop a worker.

Successive ordinary turns keep the same session ID. A new turn has a new internal execution generation; you do not need to track that value or change the resume command. While the current worker is active, wait for completion or answer its approval rather than trying to start a competing turn in the same conversation.

## Approvals while detached

In `ask` mode, an operation that needs confirmation waits for a **durable approval**. Closing the UI neither approves nor denies it. Resume the session, review the displayed tool name, inputs, diff, and warnings, and choose Yes or No in the confirmation UI. The live worker then continues the same pending invocation; it does not replay the task from the beginning.

This applies to ordinary tools and to tools used by model-delegated subagents, skills, and service agents. Background-job actions requested by the model also keep their separate approval requirements. A detached session can therefore be alive but waiting rather than making progress.

Detaching does **not** change the permission mode, widen tool access, or bypass an organization permission floor. `deny-writes` remains restrictive; `auto-accept` remains subject to policy. An Always choice cannot loosen an organization floor, and it does not turn the separate background-job policy into blanket consent. Explicit-approval-only operations still require explicit approval.

## Security and process lifetime

- **Local, not cloud execution.** The worker runs as a local process under your OS account. Closing the Agav UI is supported; laptop sleep, logout, reboot, power loss, process cleanup, or losing provider/network access are not guarantees of continued execution. Suspension can pause work and disrupt connections.
- **Supervisor isolation is not tool isolation.** The background-job supervisor launches the session worker outside the shell sandbox (`isolation: none`). Inside the worker, tool execution still enforces its permission and sandbox requirements, including required-sandbox policy. Detaching is not a sandbox bypass. A shell command explicitly launched through `run_background_job` is a separate, unsandboxed background job.
- **Credentials must be reloadable.** Workers reload trusted configuration and selected provider environment variables; they do not persist a secret-bearing config snapshot. A transient CLI credential override that differs from the reloadable credential is refused. Configure credentials in the provider environment variable or global config before starting. Stored endpoint choices cannot silently redirect current credentials after routing policy changes.
- **Durable state is not a replay engine.** Runtime state, events, and approvals live under `~/.agav/session-runtimes`, with supervisor state under `~/.agav/background-jobs`. A dead worker cannot resume its JavaScript promises. Agav does not automatically replay uncertain tool calls or restart that execution when you reopen the session.

## Supported paths and limitations

Detaching is for **worker-owned ordinary interactive turns**. It is unavailable while disabled, before worker preparation finishes, or after the turn is terminal. Direct slash-command skill invocations and direct named/service-agent submissions use different execution paths and are not made detachable by this flag. This differs from a normal prompt whose model delegates to a skill, subagent, or service agent inside its worker.

Use the documented `--resume` and `/resume` entry points to observe and answer a session. There is no public session `attach`, `approve`, `list`, or `stop` command to substitute for this flow. Do not assume the usual foreground Esc cancellation semantics stop a worker-owned session; detaching and switching presentations do not cancel its execution.

## Do and don't

**Do:**

- Enable the flag and set reloadable credentials before the task starts.
- Wait for the Ctrl+X hint, save the exact resume command, and check the picker for pending approvals.
- Review each approval and inspect the workspace before asking for follow-up work after an interruption.
- Keep the machine awake, connected, and running if you need uninterrupted local execution.

**Don't:**

- Switch to `auto-accept` merely to make detaching work; `ask` is supported.
- Treat disconnecting, renaming, or deleting a session as approval or cancellation.
- Delete `~/.agav` runtime files, edit approval JSON, or kill supervisor/worker processes as a normal management workflow. That can destroy ownership evidence or interrupt work without knowing which side effects completed.
- Assume sleep/reboot recovery will safely replay a partially executed tool call.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| “Enable backgroundJobsEnabled before starting a task” | Merge the flag into config, restart Agav, and start a new ordinary task. It cannot retrofit the current in-process execution. |
| “The current task is not owned by a background worker yet” | Wait for preparation and the detach hint. If it never appears, check whether you invoked a skill or service agent directly. |
| “This session is no longer running” | The turn may have finished while you were detaching. Use `/resume` or `agav --resume` to inspect its terminal state. |
| Session appears stuck | Look for `needs-approval` and its pending count. Resume and explicitly approve or deny the displayed request. |
| “Background execution cannot reload this transient credential override” | Move the credential to the matching provider environment variable or global config, then start a new task. |
| Worker failed or was interrupted | Resume to inspect the transcript/error and check the actual files or external effects before submitting follow-up instructions. Reopening observes recorded state; it does not resurrect a dead worker. |
| “Session execution changed” or a stale approval error | Select the session again in `/resume` to refresh its current execution and approval. Do not edit state files to force an old decision. |

See [Sessions and Memory](/workflows/sessions-and-memory) for saved history, naming, and exports, and [Background jobs](/features/background-jobs) for shell jobs and cron schedules.
