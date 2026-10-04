---
title: Security
description: Permission modes, confirmations, sandboxing, secrets, and hard-blocked commands
order: 6
---

# Security

Agav can read files, edit code, and execute commands. Choose controls appropriate to the repository and environment.

## Permission modes

| Mode | Behavior |
| --- | --- |
| `ask` | Confirm sensitive actions and show edit diffs |
| `auto-accept` | Skip normal confirmations for faster trusted workflows |
| `deny-writes` | Block writes and mutation-oriented operations |

Set a default in configuration or use `--auto-accept` and `--deny-writes` at startup. `allowedTools` can auto-approve named tools or scoped command patterns.

### Project config safety

Sensitive configuration fields are blocked from project-level `.agav/config.json` to prevent credential exfiltration and permission escalation when working in untrusted repositories. See [Configuration → Project config restrictions](/reference/configuration#project-config-restrictions) for the full list.

### deny-writes mode

In `deny-writes` mode, `edit_file`, `write_file`, and `edit_notebook`, and tools classified as destructive, are blocked even when allowlisted. A `run_command` not classified as destructive can execute when allowlisted. This is not a universal read-only boundary: command classification is heuristic, and `fetch_url` is treated as safe even for POST, PUT, PATCH, and DELETE. Do not rely on this mode alone to prevent external side effects.

### Safe tools

These tools are treated as safe by the permission gate and normally do not require confirmation. This designation does not mean they have no side effects (`save_memory` and `update_plan` write Agav state, and `fetch_url` can mutate remote services):

`read_file`, `grep_search`, `find_files`, `list_directory`, `web_search`, `lsp_query`, `read_notebook`, `fetch_url`, `overview`, `activate_skill`, `save_memory`, `update_plan`

For the daemon-backed `process` tool, `list`, `poll`, `log`, and `wait` are treated as safe. `start` and `kill` are sensitive process-control actions and follow confirmation, allowlist, and `deny-writes` behavior.

### External tool trust

External agents and MCP tools **cannot** mark themselves as non-destructive to skip confirmation. Only built-in safe tools are trusted with the `destructive: false` flag. All other tools require confirmation in `ask` mode regardless of their declared destructive status.

## Shell sandbox

Agav auto-detects the best available OS-level sandbox at startup:

| Platform | Backend | Mechanism |
| --- | --- | --- |
| macOS | Seatbelt | `sandbox-exec` with an allow-default profile and targeted restrictions |
| Linux | Bubblewrap | `bwrap` with read-only root and credential masking |
| Docker | Container | `--network=none`, memory and CPU limits |
| Windows | Env-var shaping | Strips proxy vars, sets `AGAV_SANDBOX_ACTIVE=1` |

If no backend is available, commands run unsandboxed. Set `AGAV_NO_SANDBOX=1` to intentionally disable sandbox detection.

The Seatbelt and Bubblewrap sections below describe **shell `run_command` execution**. Agent `.mjs` tool processes use separate profiles: their Seatbelt profile is deny-default, blocks network, and allows writes only in the working directory and temp; their Bubblewrap runner uses `--unshare-net`, binds host `/tmp`, and masks existing credential and `.config` directories. Do not assume shell and agent-tool network policies are identical. Bundled agents are trusted and run unsandboxed; global and project agent tools use the available agent sandbox backend.

### Background process commands

The `process` tool starts daemon-backed commands through a detached Node runner and stores records and logs under `~/.agav/background-processes/` by default. Set `AGAV_BACKGROUND_PROCESS_DIR` before starting Agav to use a different storage directory, and use the same value across restarts to reattach to those jobs. If a packaged runtime cannot execute the generated runner script, set `AGAV_NODE=/path/to/node` before starting Agav.

Background process commands are not routed through the normal `run_command` timeout and sandbox path.

Use trusted, non-interactive commands for `process start` and `/schedule background`. In `ask` mode, `process start` and `process kill` require confirmation unless an `allowedTools` rule applies. The confirmation prompt for `process start` warns that the daemon job can continue after Agav exits and may write files, use network, and consume CPU, memory, or disk. The `process kill` prompt warns that it may stop work currently in progress. `process list`, `process poll`, `process log`, and `process wait` are safe. Prefer narrow allowlist entries such as `process:pnpm test*` over a bare `process` rule. Commands that match Agav's destructive-command blocklist are blocked before the background process starts.

Scheduled process tasks created by `/schedule background`, `/schedule bg`, or `/schedule process` start the configured command directly when the cron matches, without an LLM turn or confirmation prompt, because creating the slash-command schedule is treated as explicit user consent for that command. Schedule only commands you trust.

### Seatbelt (macOS)

The Seatbelt profile uses **allow-default** with targeted restrictions; it is not a deny-all capability boundary:

- **Reads** — allowed across the filesystem, except `~/.ssh`, `~/.aws`, and `~/.gnupg`
- **Writes** — system directories (`/System`, `/usr`, `/Library`, `/Applications`) and `$HOME` are denied, with a working-directory carve-out; other locations, including the system temp directory, remain writable subject to ordinary OS permissions. `$HOME` is denied by default, with write carve-outs for the standard cache/config directories that ordinary tooling needs — `~/.cache`, `~/.config`, `~/.local`, `~/.npm`, and `~/.cargo` — so `npm`, `pip`, `cargo`, and `git` work inside the sandbox. Writes to `~/.ssh`, `~/.aws`, and `~/.gnupg` are explicitly denied so no broad allow can re-expose them.
- **Network** — allowed; do not rely on Seatbelt to prevent network access or exfiltration
- **Process execution** — allowed, except `/System/Library/CoreServices`
- **IPC** — Mach lookup, sysctl reads, and POSIX shared memory are allowed for basic process operation

### Bubblewrap (Linux)

- **Filesystem** — root is mounted read-only (`--ro-bind / /`); the working directory is writable and `/tmp` is a scratch `tmpfs`. Because the read-only root also covers `$HOME`, each standard cache/config directory — `~/.cache`, `~/.config`, `~/.local`, `~/.npm`, and `~/.cargo` — is given a writable scratch `tmpfs` so `npm`, `pip`, `cargo`, and `git` work. These tmpfs mounts are throwaway: nothing persists to or leaks from the host.
- **Credentials** — `~/.ssh`, `~/.aws`, and `~/.gnupg` are replaced with empty tmpfs mounts, hiding their contents
- **Network** — allowed; Agav does not pass `--unshare-net`
- **Lifecycle** — child processes are killed when Agav exits (`--die-with-parent`)

### Docker

- **Network** — disabled (`--network=none`)
- **Resources** — 512 MB memory, 1 CPU
- **Filesystem** — only the working directory is mounted into the container (at `/workspace`)
- **User** — the container runs as your host UID/GID (`-u uid:gid`) so files written to the working directory stay owned by you. Agav detects the daemon's security mode: under **rootless** Docker (which already maps you to the host user via user namespaces) the explicit UID mapping is omitted, and under daemon-level **userns-remap** it adds `--userns=host` so the mapping resolves to the real host user rather than a subordinate UID.

### Windows

Windows has no kernel-level sandbox. As a best-effort mitigation, Agav:

- Sets `AGAV_SANDBOX_ACTIVE=1` so well-behaved child tools can self-restrict
- Strips `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lowercase variants) to reduce network reach

### Cancellation is not isolation

**Esc** cancels an interactive turn while keeping Agav open; **Ctrl+C** exits unless it copies an active Agav selection. See [Keybindings](/reference/keybindings#cancel-versus-exit).

Native, Seatbelt, and Bubblewrap shell commands use process-group cleanup on failure, cancellation, timeout, and orderly exit; Windows uses tree termination. Successful background commands are preserved on ordinary successful completion. Cleanup is best-effort, cannot undo edits or external actions, and cannot guarantee termination of descendants that detach from the owned group.

Agent/test subprocesses receive cancellation signals without the shell runner's descendant-tree guarantees. Cancelling an MCP request stops the local wait, not necessarily server-side execution, and does not kill its shared server. Docker cancellation targets the local CLI, not guaranteed container/daemon cleanup. Check remote jobs, containers, and services separately after interruption.

Tool-activated skills receive the parent turn signal, but focused skill entries have no individual cancel handler. Manual-only slash-command skills receive no turn signal. Skill shell blocks execute directly outside the restricted tool registry and shell sandbox, and receive no cancellation signal. `fetch_url` uses its own 30-second timeout instead of the turn signal once a request starts. See [Skills](/features/skills#shell-blocks) before trusting executable skill instructions.

### Temporary output privacy

Large tool results may be saved outside the repository in private OS temporary files. They can contain secrets printed by commands or returned by APIs even when environment-variable filtering is enabled. Unix files use mode `0600` and directories `0700`, but the contents are **not encrypted**. Normal exit attempts cleanup; crash leftovers may remain until a later eligible stale-owner sweep. Do not put credentials in command output, and copy needed logs to an appropriately protected location before exiting. See [output limits and retention](/features/built-in-tools#saved-output-paths-and-retention) for quotas and exact cleanup behavior.

### MCP command validation

On Windows, MCP server subprocesses use `shell: true` for `.cmd` shim compatibility. Before spawning, Agav validates both the command and all arguments against a set of blocked shell metacharacters: `` & | < > ^ ; ` $ ( ) { } [ ] ! % " \n \r ``. If any metacharacter is found, the server startup is rejected immediately — preventing shell injection attacks through crafted MCP server configurations.

Single quotes (`'`) are explicitly allowed since they are not dangerous in `cmd.exe`.

On macOS and Linux, `shell: false` is used, so arguments are passed directly to the process without shell interpretation and no validation is needed.

### Credential filtering

Across **all** sandbox backends (including unsandboxed), environment variables whose names match `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, or `AUTH` are stripped before spawning child processes. The background process runner applies the same filtering before launching daemon jobs.

### Requiring a sandbox

Set `sandboxRequired: true` in `~/.agav/config.json` or `.agav/config.json` to make Agav refuse to start if no OS-level sandbox backend is available. This is recommended for CI, automation, and shared environments.

```json
{ "sandboxRequired": true }
```

## File tool path boundaries

The file tools (`read_file`, `write_file`, `edit_file`) enforce path boundary checks at the application level, independent of the OS sandbox:

### Write restrictions

Writes are restricted to:

- The current working directory and its children
- The system temp directory
- `~/.agav/` (Agav’s global data directory)

Writes are always denied to:

- `<cwd>/.git/` — repository metadata
- `<cwd>/.agav/` — local Agav project configuration
- Paths outside the working directory (e.g., `/etc/passwd`, `~/Desktop/file.txt`)

### Read restrictions

Reads are denied for credential stores:

- `~/.ssh/` (`%USERPROFILE%\.ssh\` on Windows)
- `~/.aws/` (`%USERPROFILE%\.aws\` on Windows)
- `~/.gnupg/` (`%USERPROFILE%\.gnupg\` on Windows)
- `~/.kube/config` (`%USERPROFILE%\.kube\config` on Windows)

### Bypass

These checks are application-level guards and cannot be bypassed by the agent. They apply regardless of permission mode or sandbox backend.

## Destructive command blocklist

High-risk patterns are blocked by the shell tool before they reach the sandbox, even in `auto-accept` mode:

- Broad deletions: `rm -rf /`, `rm -rf ~`, `rm -rf .`
- Git operations: `git reset --hard`, `git push --force`, `git clean -f`, `git branch -D`
- Privileged commands: `sudo rm`, `sudo dd`
- Disk operations: `dd if=`, `mkfs.*`, writes to `/dev/sd*`
- Permission changes: `chmod -R 777`, `chown -R`
- Database drops: `dropdb`, `DROP DATABASE`
- Process killing: `killall`, `pkill -9`
- Remote code execution: `curl ... | sh`, `wget ... | sh/bash`
- File truncation: `truncate --size 0`

The same destructive-command check is applied by `process start` before launching a daemon-backed command.

## Secrets and extensions

- Prefer API-key environment variables.
- Saved provider credentials are encrypted with AES-256-GCM before being written to global configuration.
- Vertex AI’s service-account JSON is not an API key and is never encrypted into `config.json` — it is read from the path in `VERTEX_AI_CREDENTIALS_PATH` or `vertexAICredentialsPath`. Keep the file outside the repository, restrict its permissions, and grant the service account only the `roles/aiplatform.user` role it needs.
- Do not commit secrets to `./.agav/config.json`.
- MCP servers and plugins are executable local integrations. Review their source and configuration before enabling them.
- Use narrow CI permissions and `--max-turns` to limit unattended work.
