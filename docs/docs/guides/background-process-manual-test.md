---
title: Background Process Manual Test Plan
description: Manual verification checklist for daemon-backed background processes
navHidden: true
---

# Background Process Manual Test Plan

Use this checklist when validating daemon-backed background processes on `feat/background-process-tool`. Run it in a disposable repository or folder.

## Feature summary

The `process` tool starts and manages long-running shell commands in a detached daemon runner.

Supported actions:

- `start` — start a daemon-backed background command.
- `list` — list all known background jobs.
- `poll` — check one job's status.
- `log` — read captured stdout/stderr logs.
- `wait` — wait for a job to finish up to a timeout.
- `kill` — terminate a running job.

Expected persistence behavior:

- Jobs continue running after `/exit` or terminal UI shutdown.
- Job records and logs are stored under `~/.agav/background-processes/` by default.
- On restart, Agav reattaches to persisted records and reports completed jobs once.
- Scheduled background jobs can be created with `/schedule background`, `/schedule bg`, and `/schedule process`.

## Preconditions

1. Check out and build or run Agav from `feat/background-process-tool`.
2. Start Agav in a test repository or disposable folder.
3. Ensure `node` is available for the `node -e` examples.
4. If a packaged runtime cannot launch the daemon runner, start Agav with:

   ```bash
   AGAV_NODE=/absolute/path/to/node agav
   ```

5. Optional: isolate test artifacts with a temporary process directory:

   ```bash
   AGAV_BACKGROUND_PROCESS_DIR=/tmp/agav-bg-test agav
   ```

6. Remove stale test records only when you are sure no active test jobs are running.

## Storage paths to inspect

Default background process storage:

```text
~/.agav/background-processes/<job-id>.json
~/.agav/background-processes/<job-id>.stdout.log
~/.agav/background-processes/<job-id>.stderr.log
~/.agav/background-processes/process-runner.mjs
```

If `AGAV_BACKGROUND_PROCESS_DIR` is set, inspect that directory instead.

## Test 1 — Start a normal background job

Ask Agav:

```text
Use the process tool to start this in the background: node -e "setTimeout(() => console.log('hello-from-background'), 10000)"
```

Pass when:

- Agav asks for confirmation before starting the daemon-backed process in normal `ask` mode.
- The confirmation text warns that the process may keep running after Agav exits and can write files, use network, and consume CPU, memory, or disk.
- The main UI does not block for 10 seconds after approval.
- Agav returns an 8-character process ID.
- The response says the job keeps running after Agav exits and reattaches on restart.
- A completion notification appears in the main chat with `hello-from-background`.

## Test 2 — List, poll, log, and wait

Replace `<id>` with the ID from Test 1:

```text
Use the process tool to list all background jobs.
Use the process tool to poll job <id>.
Use the process tool to show the last 5 lines from job <id>.
Use the process tool to wait up to 30 seconds for job <id>.
```

Pass when:

- `list` includes the job ID, status, cwd, and command.
- `poll` shows a readable status such as `running` or `exited 0`.
- `log` shows stdout/stderr sections or `No output captured yet.` while the job is still quiet.
- `wait` returns captured logs after completion, or reports that the process is still running after the timeout.

## Test 3 — Reattach after Agav restart

Start a longer job:

```text
Use the process tool to start this in the background: node -e "setTimeout(() => console.log('reattached-ok'), 45000)"
```

Immediately exit:

```text
/exit
```

Wait at least 45 seconds, then restart Agav in the same folder with the same `AGAV_BACKGROUND_PROCESS_DIR` value, if one was used.

Pass when:

- The job continues after Agav exits.
- Restarting Agav reports the completed process in the main chat.
- The notification includes `reattached-ok`.
- The same completed job is not reported again after another restart.
- The job JSON record has `notifiedAt` after the notification.

## Test 4 — Scheduled background command

Pick the next minute and create one scheduled background command:

```text
/schedule background "<minute> <hour> * * *" node -e "console.log('scheduled-bg-ok')"
```

Also verify the aliases on separate schedules or after removing the first schedule:

```text
/schedule bg "<minute> <hour> * * *" node -e "console.log('scheduled-bg-ok')"
/schedule process "<minute> <hour> * * *" node -e "console.log('scheduled-bg-ok')"
```

Run:

```text
/schedule list
```

Pass when:

- `/schedule list` marks each entry as `[process]`.
- The entry shows `Command: node -e "console.log('scheduled-bg-ok')"`.
- At the scheduled minute, Agav starts a daemon-backed process without an LLM turn.
- The start message says `Scheduled background process ...`.
- Completion is later reported in the main chat and includes `scheduled-bg-ok`.
- The process record and logs appear under the active background-process directory.

## Test 5 — Existing scheduled agent prompts still work

Create a normal prompt schedule for the next minute:

```text
/schedule add "<minute> <hour> * * *" say scheduled prompt ok
```

Pass when:

- `/schedule list` marks it as `[prompt]`.
- The entry shows `Prompt: say scheduled prompt ok`.
- At the scheduled minute, Agav submits an automated agent prompt instead of starting a process directly.
- Process schedules and prompt schedules remain distinct in the list.

## Test 6 — Kill a background process

Start a long job:

```text
Use the process tool to start this in the background: node -e "setTimeout(() => console.log('too-late'), 300000)"
```

Kill it and poll status:

```text
Use the process tool to kill job <id>.
Use the process tool to poll job <id>.
```

Pass when:

- Kill reports `Sent SIGTERM to background process <id>.` or marks the job killed when no live PID is reachable.
- Polling shows `killed by SIGTERM` or the selected signal.
- The process does not later complete normally or print `too-late`.

## Test 7 — Safety and permissions

### Destructive command block

Ask Agav:

```text
Use the process tool to start this in the background: git reset --hard
```

Pass when the tool refuses the command because it matches a destructive command pattern.

### Confirmation behavior

In default `ask` mode, start or kill a process:

```text
Use the process tool to start this in the background: node -e "console.log('confirm-ok')"
```

Pass when `process start` and `process kill` require confirmation unless an `allowedTools` rule applies. `process list`, `process poll`, `process log`, and `process wait` should not require confirmation.

### Allowlist behavior

With an allowlist such as:

```json
{
  "allowedTools": ["process:node -e *confirm-ok*"]
}
```

Pass when the matching `process start` can run without confirmation, while unrelated process commands still follow the active permission mode. Prefer scoped patterns over a bare `process` rule.

## Test 8 — Custom runtime and storage variables

Start Agav with both variables set:

```bash
AGAV_NODE=/absolute/path/to/node AGAV_BACKGROUND_PROCESS_DIR=/tmp/agav-bg-test agav
```

Start and complete a short process:

```text
Use the process tool to start this in the background: node -e "console.log('custom-dir-ok')"
```

Pass when:

- Records, stdout logs, stderr logs, and `process-runner.mjs` are created under `/tmp/agav-bg-test`.
- The job completes and logs include `custom-dir-ok`.
- Restarting Agav with the same `AGAV_BACKGROUND_PROCESS_DIR` can list or reattach to the job.

## Things to watch for

Report a bug if any of these happen:

- A background command blocks the main UI until it finishes.
- A completed background job does not show a main-window status message.
- A job does not survive `/exit` and restart.
- A completed job is reported repeatedly on every restart.
- `/schedule background`, `/schedule bg`, or `/schedule process` creates a normal prompt task instead of a process task.
- `/schedule list` does not show `[process]` for background schedules.
- Logs are missing even though the command printed output.
- `process kill` reports success but the process keeps running.
- Jobs remain in `starting` when `AGAV_NODE` points at a valid Node executable.

## Cleanup

Completed records and logs are under `~/.agav/background-processes/` unless `AGAV_BACKGROUND_PROCESS_DIR` was set.

Delete only stale completed test jobs. Do not delete active jobs unless they are known test processes.
