---
title: Background jobs
description: Run long-lived commands and recurring schedules that outlive a single turn
order: 7
---

# Background jobs

Background jobs are an opt-in subsystem for commands that must keep running after the agent's turn ends, such as dev servers, long builds, and watchers. They can also be launched on a cron schedule. The agent starts and manages them with the `run_background_job` tool; you inspect and control them with `/job`.

Enable it in `~/.agav/config.json`:

```json
{ "backgroundJobsEnabled": true }
```

While the flag is unset or `false`, `run_background_job` and `/job` refuse every action.

> **Background jobs are not sandboxed.** Jobs launched through `run_background_job` run with `isolation: none`: full access as your OS user, outside the Seatbelt, Bubblewrap, and Docker sandboxes that `run_command` uses, and without its 30-second timeout. Read the confirmation prompt before approving.

## What a job is

Each job is a shell command run by a small detached supervisor process, so it keeps running when Agav exits. Agav stores job state, grants, and captured output under `~/.agav/background-jobs` (`%USERPROFILE%\.agav\background-jobs` on Windows).

- **States:** a job moves through `accepted`, `starting`, and `running`, then ends as `completed`, `failed`, or `interrupted`. If Agav cannot establish the truth after a crash it reports `unknown` or `recovery-required` with a reason; it never reports success without evidence.
- **Output:** stdout and stderr are captured separately and can be read while the job is still running.
- **Limits:** at most 4 jobs run at once. Further starts are refused rather than queued.
- **Supervisor lifetime:** a finished job's supervisor stays up for about five minutes to serve `poll` and `log`, then exits on its own.
- **Descendants:** if the shell exits but a child it started keeps running, the job stays `running` until that child ends. Stopping it then reports `interrupted`.
- **Stopping:** `stop` signals the whole process group and escalates if needed. Processes that deliberately escape the group (double fork, `setsid`) are not tracked, and Windows only guarantees the top-level process.

## Agent tool

`run_background_job` takes an `action`:

| Action | Purpose |
| --- | --- |
| `start` | Launch a shell command and return a job ID immediately. |
| `list`, `poll` | Show known jobs, or the current state of one. |
| `log` | Read captured output. Choose `stream` (`stdout` or `stderr`) and `tail` for only the last N bytes; the default is the first 64 KiB. |
| `wait` | Block until a job is terminal. Cancelling the turn ends the wait, not the job. |
| `stop` | Request termination of one job. |
| `schedule-create`, `schedule-list`, `schedule-revoke` | Manage recurring schedules (see below). |

Job IDs can be given as unambiguous prefixes.

## `/job` command

| Command | Purpose |
| --- | --- |
| `/job` | Open the interactive manager. Tab switches between Jobs and Schedules. |
| `/job list` | Show all known jobs. |
| `/job poll <id>` | Show the state of one job. |
| `/job log <id> [--stderr] [--tail N]` | Show stdout (default) or stderr; `--tail N` returns the last N bytes. |
| `/job stop <id>` | Request termination of one job. |
| `/job schedule list` | Show schedules. |
| `/job schedule create "<cron>" <timezone> <command>` | Register a recurring command. |
| `/job schedule revoke <scheduleId>` | Permanently stop a schedule from launching. |
| `/job capabilities` | Show what this platform can enforce. |

`/job` cannot start a one-off job; ask the agent to use `run_background_job`.

In the manager, the job list shows each job's command and directory, and search matches both. Press `x` to stop the selected job. In the Schedules tab, `n` creates a schedule, `t` pauses or resumes one, and `d` revokes it.

`/job stop`, `/job schedule create`, and `/job schedule revoke` show the approval prompt inline in the interactive app. If no prompt is available, they open the manager so you can approve there; the original action is not re-run for you. An unknown or ambiguous job ID is reported as an error and never opens the manager.

`/job log <id>` shows stdout. For a job that failed, it also appends the exit code and its stderr, so you do not have to rerun with `--stderr`. Passing `--stdout` or `--stderr` shows only that stream.

When you exit Agav, the exit message lists the IDs of any background jobs still running, next to the session resume hint.

## Approval and permission modes

Starting a job, creating a schedule, stopping a job, and revoking a schedule are each a separate approved action. The prompt shows the full command, the working directory, the isolation level (flagged when unrestricted), and for schedules the cron expression and timezone.

**Approvals are reusable.** Approving a spec covers that exact command, directory, and isolation (and for schedules, the cron and timezone) for that action. Changing any of them asks again. A schedule you approve launches every future run without asking until you revoke it.

| Mode | Behavior |
| --- | --- |
| `ask` | Prompts for each action that has no existing approval. |
| `auto-accept` | Approves automatically. Use only in trusted workflows. |
| `deny-writes` | Refuses new jobs and new schedules. Stopping a job and revoking or pausing a schedule still prompt, so you can always shut down existing work. Resuming a paused schedule is refused. |

In print and `agav run` mode no one can answer a prompt, so these actions are refused unless an explicit grant already covers them. A model cannot opt out of this through tool arguments.

## Recurring schedules

A schedule launches its command on a five-field cron expression in an IANA timezone, for example `"*/15 * * * *" UTC`. Wildcard steps start at the field's minimum, so day-of-month `*/2` matches the 1st, 3rd, 5th, and so on.

- **Fixed at approval.** The working directory is resolved to an absolute path and the environment is captured when you create the schedule, then both are covered by the approval. A run uses exactly that directory and environment, regardless of which session or process triggers it.
- **One active job per schedule.** If the previous run is still going, the next occurrence is skipped.
- **No catch-up.** A missed occurrence is not queued or backfilled.
- **Revoking is permanent.** It blocks future launches only; jobs already launched keep running. A revoked schedule stays listed as revoked. Pausing is reversible.
- **`deny-writes` sessions pause launches.** While a connected session is in `deny-writes`, schedules do not fire.

### When schedules are evaluated

By default, schedules are checked about every 30 seconds **only while an interactive Agav session with `backgroundJobsEnabled` is running**. Closing Agav stops evaluation.

To fire schedules while Agav is closed, configure unattended automation explicitly. It reads only the global config and never creates project files.

| Command | Behavior |
| --- | --- |
| `agav job tick` | Evaluate due schedules once and exit. |
| `agav job tick --install` | Register an OS entry that runs `agav job tick` every minute: systemd timer or cron on Linux, a LaunchAgent on macOS, a scheduled task on Windows. |
| `agav job tick --status` | Show the entry. Exits `0` if installed, `3` if not. |
| `agav job tick --uninstall` | Remove the entry. Job state on disk is kept. |
| `agav job daemon start` | Run a foreground daemon that ticks every 15 seconds until interrupted. |
| `agav job daemon stop` | Stop the running daemon. |
| `agav job daemon status` | Exits `0` if running, `3` if not. |

Set `"backgroundAutomation": "paused"` in the **global** config to make `tick` and the daemon do nothing without uninstalling them. It is ignored in project config. Unattended runs have no one to prompt, so they launch only schedules you already approved.

An interactive session and an unattended host can run together; the same occurrence is never launched twice.

## Completion notifications

Completion events are recorded when a job finishes, but Agav does not yet show them. **No automatic "job finished" notification is delivered.** Check on a job with `/job list`, `/job poll <id>`, `/job log <id>`, or the `/job` manager.

## Platform notes

Run `/job capabilities` to see what your platform reports. Linux and macOS own a process group per job. Windows has no Job Object tree ownership in this release, so stopping a job may leave child processes running. Unattended automation needs a filesystem that supports hard links; without it, Agav refuses to reserve a schedule occurrence rather than risk launching it twice.

See also [Automation](/workflows/automation) for session loops, `/schedule`, and `/watch`, and [Security](/reference/security#background-jobs) for the trust model.
