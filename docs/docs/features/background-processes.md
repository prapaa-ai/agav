---
title: Background Processes
description: Start, monitor, schedule, and reattach daemon-backed shell commands
order: 3
---

# Background Processes

Agav's `process` tool manages long-running shell commands without blocking the main agent turn. Use it for dev servers, slow integration tests, builds, local scripts, and other trusted commands that should keep running after the current Agav UI exits.

For repeated agent prompts, use `/loop` or `/schedule add`. For repeated shell commands that should become daemon-backed jobs, use `/schedule background`, `/schedule bg`, or `/schedule process`.

## Purpose

Background processes solve two common automation problems:

- **Non-blocking long commands** — start a shell command and keep chatting while it runs.
- **Durable command jobs** — persist job state and logs so a command can complete after Agav exits and be reported when Agav starts again.

## Architecture

- `process start` writes a job record, generates `process-runner.mjs` if needed, and launches a detached Node runner.
- The runner executes the command with `shell: true` in the selected working directory, captures stdout and stderr, and updates the persisted job record.
- Job status moves through `starting` and `running`, then one terminal state: `exited`, `failed`, `killed`, or `error`.
- Jobs continue running after Agav exits because the runner is detached from the interactive UI.
- When Agav starts again, the interactive UI scans persisted records every 2 seconds while a session is open.
- Completed jobs that have not been reported yet are added to the main chat once with the command and last output, then marked with `notifiedAt` so they are not reported repeatedly on later restarts.
- Process IDs are 8-character IDs. `poll`, `log`, `wait`, and `kill` accept a full ID or a prefix; use a unique prefix to avoid matching the wrong record.

## Storage and reattach

By default, records and logs live under the Agav config directory at `~/.agav/background-processes/`:

```text
~/.agav/background-processes/<job-id>.json
~/.agav/background-processes/<job-id>.stdout.log
~/.agav/background-processes/<job-id>.stderr.log
~/.agav/background-processes/process-runner.mjs
```

The job JSON record contains:

```ts
interface BackgroundProcessRecord {
  id: string;
  command: string;
  cwd: string;
  status: "starting" | "running" | "exited" | "failed" | "killed" | "error";
  startedAt: string;
  finishedAt?: string;
  pid?: number;
  runnerPid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutPath: string;
  stderrPath: string;
  error?: string;
  notifiedAt?: string;
}
```

Set `AGAV_BACKGROUND_PROCESS_DIR` before starting Agav to store records and logs somewhere else, for example during tests:

```bash
AGAV_BACKGROUND_PROCESS_DIR=/tmp/agav-bg agav
```

When Agav restarts, it reads persisted records from the same directory. If a completed record has no `notifiedAt`, the UI reports it once and updates the record.

## API reference

The tool name is `process`.

```ts
type ProcessAction = "start" | "list" | "poll" | "log" | "wait" | "kill";

interface ProcessInput {
  action: ProcessAction;
  command?: string;
  id?: string;
  cwd?: string;
  lines?: number;
  timeout_ms?: number;
  signal?: string;
}
```

| Field | Required for | Default | Description |
| --- | --- | --- | --- |
| `action` | all actions | — | One of `start`, `list`, `poll`, `log`, `wait`, or `kill`. |
| `command` | `start` | — | Shell command to run in the daemon-backed process. |
| `id` | `poll`, `log`, `wait`, `kill` | — | Background process ID or prefix. |
| `cwd` | optional for `start` | current project directory | Working directory for the command. Relative paths are resolved before launch. |
| `lines` | optional for `log`, `wait` | `80` | Number of stdout/stderr log lines to return. Maximum: `1000`. |
| `timeout_ms` | optional for `wait` | `30000` | Maximum time to wait before returning. Maximum: `600000`. |
| `signal` | optional for `kill` | `SIGTERM` | Signal sent to the child PID and runner PID when reachable. |

The output is plain text in Agav's standard tool result shape:

```ts
interface ToolResult {
  output: string;
  isError: boolean;
}
```

## Actions

| Action | Behavior |
| --- | --- |
| `start` | Starts a detached daemon-backed command and returns the process ID. The command is blocked if it matches Agav's destructive-command blocklist. |
| `list` | Lists all persisted background process records from the active background-process directory. |
| `poll` | Returns one process record with status, PID when known, duration, cwd, and command. |
| `log` | Returns process metadata plus captured stdout and stderr tails. |
| `wait` | Polls until the process reaches a terminal state or `timeout_ms` expires, then returns logs. If the timeout expires first, it reports that the job is still running. |
| `kill` | Marks the process as killed and sends `signal` to the child PID and runner PID when reachable. |

Status values shown in `poll`, `list`, `log`, and `wait` are formatted as `starting`, `running`, `exited 0`, `failed <code>`, `killed by <signal>`, or `error: <message>`.

## Usage examples

Ask Agav to use the background process tool when a command should not block the main turn:

```text
Use the process tool to start this in the background: node -e "setTimeout(() => console.log('done'), 15000)"
```

Then ask for updates by ID:

```text
Use the process tool to list all background jobs.
Use the process tool to poll job <id>.
Use the process tool to show the last 20 log lines for job <id>.
Use the process tool to wait up to 30 seconds for job <id>.
Use the process tool to kill job <id>.
```

Typical returned status text looks like:

```text
<id> [running] pid=12345 8s
  cwd: /path/to/repo
  command: node -e "setTimeout(() => console.log('done'), 15000)"
```

When the job finishes, Agav adds a system message to the main chat:

```text
Background process <id> completed successfully after 15s.
Command: node -e "..."
Last output:
done
```

Failed and killed jobs are also reported once. If stderr has output, the notification's `Last output` uses stderr before stdout.

## Scheduled background commands

Use `/schedule background` to save a recurring shell command that starts a daemon-backed process directly, without an LLM turn at trigger time:

```text
/schedule background "0 9 * * 1-5" pnpm test
```

Aliases are equivalent:

```text
/schedule bg "*/15 * * * *" npm run smoke
/schedule process "30 17 * * 5" node scripts/report.js
```

Manage process schedules with the same commands as prompt schedules:

```text
/schedule list
/schedule disable <id>
/schedule enable <id>
/schedule remove <id>
```

`/schedule list` marks background-command entries as `[process]` and shows `Command: ...`. Prompt schedules remain `[prompt]` entries and are created with `/schedule add "<cron>" <prompt>`.

The distinction matters at trigger time:

- `/schedule add` submits the saved prompt to the agent as an automated turn.
- `/schedule background`, `/schedule bg`, and `/schedule process` start the saved command directly with the `process` tool and do not wait for an LLM turn.

Schedules are stored in `~/.agav/scheduled-tasks.json`. Agav must be running in the interactive UI when the cron expression matches; the scheduler checks once every 30 seconds and runs matching tasks at most once per minute. Once a process schedule starts its daemon job, that job continues after Agav exits and is reported on the next running session when it completes.

## Configuration

| Setting or variable | Default | Description |
| --- | --- | --- |
| Background process directory | `~/.agav/background-processes/` | Holds process records, captured logs, and the generated runner script. Override with `AGAV_BACKGROUND_PROCESS_DIR`. |
| `AGAV_BACKGROUND_PROCESS_DIR` | default directory when unset | Absolute or relative directory used instead of `~/.agav/background-processes/` for all background process records and logs. Useful for tests or relocating job state. Use the same value across restarts to reattach to those jobs. |
| Runner executable | `process.execPath` | Node executable used to launch `process-runner.mjs`. Override with `AGAV_NODE`. |
| `AGAV_NODE` | unset | Node.js executable used by daemon runners when the current runtime cannot execute the generated runner script. |
| Wait timeout | `30000` ms | Per-call default for `process wait`; capped at `600000` ms. |
| Log tail | `80` lines | Per-call default for `process log` and `process wait`; capped at `1000` lines. |

Set `AGAV_NODE` before starting Agav when packaged or custom runtimes need a specific Node.js binary for daemon jobs:

```bash
AGAV_NODE=/usr/local/bin/node agav
```

For isolated manual tests, combine both environment variables:

```bash
AGAV_NODE=/usr/local/bin/node AGAV_BACKGROUND_PROCESS_DIR=/tmp/agav-bg agav
```

## Safety and permissions

- `process list`, `process poll`, `process log`, and `process wait` are treated as safe tool calls.
- `process start` and `process kill` are sensitive process-control actions. In `ask` mode, they require confirmation unless an `allowedTools` rule applies.
- The confirmation prompt for `process start` explicitly warns that the command starts a daemon-backed background process that can keep running after Agav exits and may write files, use network, and consume CPU, memory, or disk.
- The confirmation prompt for `process kill` explicitly warns that the signal can stop work currently in progress.
- In `deny-writes` mode or headless `ask` mode without a confirmation handler, `process start` and `process kill` are blocked unless the call is otherwise safe or explicitly allowed by the current policy.
- `auto-accept` skips normal confirmation prompts. Use narrow `allowedTools` patterns such as `process:pnpm test*` instead of allowing every `process` call.
- A bare `process` allowlist rule permits every process action. Scoped `process:<pattern>` rules match the command for `start`, the ID for `kill`, and the ID/action for read-only process calls.
- Commands that match Agav's destructive-command blocklist, such as `git reset --hard`, are blocked by the process tool before they start.
- `/schedule background`, `/schedule bg`, and `/schedule process` are explicit slash commands. Creating the schedule is treated as user consent for that command. At trigger time they start the configured command directly, without an LLM turn or confirmation prompt. Schedule only trusted, non-interactive commands.
- Background process commands are launched by the daemon runner rather than through the normal `run_command` timeout and sandbox path. Run only commands you trust, avoid interactive commands, and quote shell input carefully.
- Environment variables whose names look like credentials (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, or `AUTH`) are stripped before spawning the runner and child command.

## Troubleshooting

### A job stays in `starting`

The detached runner may not have started. If you are using a packaged runtime or custom launcher, set `AGAV_NODE` to a known Node.js executable and start Agav again:

```bash
AGAV_NODE=/usr/local/bin/node agav
```

Then start a new background process and inspect it with `process log` or `process poll`.

### Completion was not reported

Completion notifications are emitted by the interactive UI. If Agav was closed when the job finished, restart Agav with the same `AGAV_BACKGROUND_PROCESS_DIR` value, then wait a few seconds. A completed job with `notifiedAt` in its JSON record has already been reported.

### Logs are missing

Use `process log` first. If no output is shown, inspect the job's stdout and stderr files under the active background-process directory. Commands that buffer output may not write lines until they exit.

### A scheduled background command did not run

Agav must be open when the cron expression matches. Run `/schedule list` and confirm the task is enabled and marked `[process]`. Prompt schedules are marked `[prompt]` and submit text to the agent instead of starting a command directly.

## Manual test checklist

For release testing, use the full [Background Process Manual Test Plan](/guides/background-process-manual-test) in a disposable repository. At minimum, verify:

1. Start a background command that prints a known string after a short delay; confirm the UI remains usable and a completion notification appears.
2. Run list, poll, log, and wait requests against the process ID; confirm logs include the known output.
3. Start a longer job, exit Agav, wait for completion, then restart Agav; confirm the reattach notification appears once and is not repeated on another restart.
4. Add `/schedule background`, `/schedule bg`, or `/schedule process` for the next minute; confirm `/schedule list` shows `[process]`, the command starts without an LLM turn, and completion is reported.
5. Confirm an existing `/schedule add` prompt task still appears as `[prompt]` and submits to the agent at its scheduled time.
6. Start a long process, kill it, then poll it; confirm the status is `killed by SIGTERM` or the selected signal.
7. Confirm a destructive command such as `git reset --hard` is refused by the process tool.
8. If testing a packaged runtime, set `AGAV_NODE` to a known Node.js executable and repeat the start/log flow.
9. If testing custom storage, set `AGAV_BACKGROUND_PROCESS_DIR` and confirm records, logs, and reattach all use that directory.

Clean up stale completed records and logs from `~/.agav/background-processes/` or the directory named by `AGAV_BACKGROUND_PROCESS_DIR` when testing is complete. Do not delete active jobs unless they are known test processes.
