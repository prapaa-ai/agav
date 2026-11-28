---
title: Background jobs
description: Run long-lived commands and recurring schedules that outlive a single turn
order: 7
---

# Background jobs

Background jobs are an opt-in subsystem for commands that must keep running after the agent's turn ends, such as dev servers, long builds, and watchers. They can also be launched on a cron schedule. The agent starts and manages them with the `run_background_job` tool; you inspect and control them with `/job`.

To leave an **agent conversation** running rather than a shell command, see [Detached sessions](/features/detached-sessions). The same `backgroundJobsEnabled: true` flag enables worker-owned ordinary interactive prompts when set before submitting the task; no separate opt-in is needed. `/detach` and `agav --resume <session-id>` manage the conversation; `/job` manages shell jobs.

Enable it in `~/.agav/config.json`:

```json
{ "backgroundJobsEnabled": true }
```

While the flag is unset or `false`, `run_background_job` and `/job` refuse every action.

> **Background jobs are not sandboxed.** Jobs launched through `run_background_job` run with `isolation: none`: full access as your OS user, outside the Seatbelt, Bubblewrap, Windows restricted-token, and Docker sandboxes available to `run_command`, and without its 30-second timeout. Read the confirmation prompt before approving.

## What a job is

Each job is a shell command run by a small detached supervisor process, so it keeps running when Agav exits. Agav stores job state, grants, and captured output under `~/.agav/background-jobs` (`%USERPROFILE%\.agav\background-jobs` on Windows).

- **States:** a job moves through `accepted`, `starting`, and `running`, then ends as `completed`, `failed`, or `interrupted`. If Agav cannot establish the truth after a crash it reports `unknown` or `recovery-required` with a reason; it never reports success without evidence.
- **Output:** stdout and stderr are captured separately and can be read while the job is still running.
- **Limits:** at most 4 jobs run at once. Further starts are refused rather than queued.
- **Supervisor lifetime:** a finished job's supervisor stays up for about five minutes to serve `poll` and `log`, then exits on its own.
- **Descendants:** on macOS and Linux, a job can stay `running` after its shell exits while descendants in the owned process group are still running. Windows shell jobs do not provide that guarantee.
- **Stopping:** where group ownership is available, `stop` signals the owned group and escalates if needed. Processes that escape the group are not tracked. On Windows, the reported stop covers only the top-level process; descendant status can remain unverified.

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

Use `command` for `start` and `schedule-create`; optional `cwd` defaults to Agav’s working directory. `schedule-create` also requires `cron` and `timezone`. Use `jobId` for `poll`, `log`, `wait`, or `stop`; unambiguous prefixes are accepted. Use an exact `scheduleId` for `schedule-revoke`.

## `/job` command

| Command | Purpose |
| --- | --- |
| `/job` | Open the interactive manager. Tab switches between Jobs and Schedules. |
| `/job list` | Show all known jobs. |
| `/job poll <id>` | Show the state of one job. |
| `/job log <id> [--stdout or --stderr] [--tail N]` | Show stdout (default) or stderr; `--tail N` returns the last N bytes. |
| `/job stop <id>` | Request termination of one job. |
| `/job schedule list` | Show schedules. |
| `/job schedule create "<cron>" <timezone> <command>` | Register a recurring command. |
| `/job schedule revoke <scheduleId>` | Permanently stop a schedule from launching. |
| `/job abandon <full-id> --acknowledge-unverified` | Release capacity for an eligible unverified job without stopping it or deleting its evidence. |
| `/job capabilities` | Show what this platform can enforce. |

`/job` cannot start a one-off job; ask the agent to use `run_background_job`.

In the manager, the job list shows each job’s command and directory, and search matches both. Press `x` to stop an eligible job. In the Schedules tab, `n` creates a schedule, `t` pauses or resumes it, `x` revokes it, and `d` deletes an eligible inactive schedule and its run history without deleting the jobs it launched.

Use abandonment only after inspecting an unverified job and its side effects. It releases accounting capacity and prevents a future startup of that job, but **does not stop any process, verify the outcome, or authorize a retry**. The manager offers `a` for eligible jobs and `h` to show or hide retained abandoned evidence. The shell equivalent of the slash command is `agav job abandon <full-id> --acknowledge-unverified`.

Press uppercase `D` in either list and confirm with `y` to permanently delete finished jobs (including their logs) and eligible paused or revoked schedules (including their run history) across both tabs. This ignores search filters. Active or uncertain jobs, abandoned job evidence, enabled schedules, and schedules with an active job or pending launch are kept.

`/job stop`, `/job schedule create`, and `/job schedule revoke` show the approval prompt inline in the interactive app. During an active turn, `/job list`, `/job poll <id>`, `/job log <id>`, `/job capabilities`, `/job schedule list`, and `/job stop <id>` can run without switching views. A targeted stop still requires its normal authorization. If approval cannot be shown inline, a busy session returns instructions rather than opening the manager. An idle session can open the manager for you to take the action there; the original action is not re-run. An unknown or ambiguous job ID is reported as an error and never opens the manager.

`/job log <id>` shows the first 64 KiB of retained stdout by default. Use `--tail N` with a positive whole number of bytes for the end of the stream. For a job that failed, it also appends the exit code and its stderr, so you do not have to rerun with `--stderr`. Passing `--stdout` or `--stderr` shows only that stream.

On normal interactive exit, Agav reports jobs it verifies are active separately from jobs with unverified status. An unverified job may still be running. Finished and abandoned jobs are omitted.

## Approval and permission modes

Starting a job, creating a schedule, stopping a job, and revoking a schedule are each a separate approved action. The prompt shows the full command, the working directory, the isolation level (flagged when unrestricted), and for schedules the cron expression and timezone.

**Approvals are reusable.** Approving a spec covers that exact command, directory, and isolation (and for schedules, the cron and timezone) for that action. Changing any of them asks again. An approved schedule can launch future runs without prompting each time, subject to its state and the current automation policy.

| Mode | Behavior |
| --- | --- |
| `ask` | Prompts for each action that has no existing approval. |
| `auto-accept` | Approves automatically. Use only in trusted workflows. |
| `deny-writes` | Refuses new jobs and new schedules. Stopping a job and revoking or pausing a schedule still prompt, so you can always shut down existing work. Resuming a paused schedule is refused. |

In print and `agav run` mode no one can answer a prompt, so these actions are refused unless an explicit grant already covers them. A model cannot opt out of this through tool arguments.

## Recurring schedules

A schedule launches its command on a five-field cron expression in an IANA timezone, for example `"*/15 * * * *" UTC`. Wildcard steps start at the field's minimum, so day-of-month `*/2` matches the 1st, 3rd, 5th, and so on.

Enter these examples **inside Agav**, not at your shell prompt. On macOS and Linux, jobs run via `/bin/sh`:

```text
/job schedule create "*/15 * * * *" UTC date
```

On Windows, invoke Windows PowerShell explicitly for PowerShell commands:

```text
/job schedule create "*/15 * * * *" UTC powershell.exe -NoProfile -NonInteractive -Command Get-Date
```

On Windows the job runner defaults to `cmd.exe` even if you start Agav from PowerShell. It does not translate shell syntax. Otherwise, use `cmd.exe` syntax.

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
| `agav job tick --install` | Register an OS entry that evaluates schedules every minute: systemd timer or cron on Linux, a LaunchAgent on macOS, a scheduled task on Windows. |
| `agav job tick --status` | Show the entry. Exits `0` if installed, `3` if not. Reinstall if reported stale or outdated. |
| `agav job tick --uninstall` | Remove the entry. Job state on disk is kept. |
| `agav job daemon start` | Run a foreground daemon that ticks every 15 seconds until interrupted. |
| `agav job daemon stop` | Stop the running daemon. |
| `agav job daemon status` | Exits `0` if running, `3` if not. |

Set `"backgroundAutomation": "paused"` in the **global** config to suspend background schedule evaluation without uninstalling the OS entry or stopping the daemon. This also pauses the interactive background schedule ticker; it does not cancel running jobs and is ignored in project config. Unattended runs have no one to prompt, so they launch only schedules you already approved.

An interactive session and an unattended host can run together; the same occurrence is never launched twice.

## Completion notifications

Completion events are recorded when a job finishes, but Agav does not yet show them. **No automatic "job finished" notification is delivered.** Check on a job with `/job list`, `/job poll <id>`, `/job log <id>`, or the `/job` manager.

## Platform notes

Run `/job capabilities` to see what your platform reports. Linux and macOS own a process group per job. Windows has no Job Object tree ownership in this release, so stopping a job may leave child processes running. Unattended automation needs a filesystem that supports hard links; without it, Agav refuses to reserve a schedule occurrence rather than risk launching it twice.

See also [Automation](/workflows/automation) for session loops, `/schedule`, and `/watch`, and [Security](/reference/security#background-jobs) for the trust model.
