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

### Changing the mode during a session

In an interactive session you can switch the permission mode at any time with [`/permission`](/reference/slash-commands). Run bare `/permission` to open a picker, or pass a mode directly (`/permission deny-writes`). The chosen mode is saved with the session and **restored when you resume it**, so a session you escalated to `auto-accept` or tightened to `deny-writes` comes back in that mode. It does not change the launch default used for `/new` or for future sessions — set `permissionMode` in configuration for that.

Explicit `--auto-accept` (`-y`) and `--deny-writes` flags at startup take precedence over a session's saved mode. An organization `permissionMode` floor is always applied last: `/permission` and the picker let you choose a *stricter* mode but clamp any attempt to loosen below the floor, and report the mode actually in force. Changing the mode is only available in an interactive session — in headless `agav run` and print mode, `permissionMode` from configuration is authoritative.

> `/permission` (the interactive session mode) is distinct from the `--permission <json>` CLI flag, which supplies a JSON tool policy for `agav run`. See [CLI reference](/reference/cli).

### Project config safety

Sensitive configuration fields are blocked from project-level `.agav/config.json` to prevent credential exfiltration and permission escalation when working in untrusted repositories. See [Configuration → Project config restrictions](/reference/configuration#project-config-restrictions) for the full list.

### deny-writes mode

In `deny-writes` mode, `edit_file`, `write_file`, and `edit_notebook`, and tools classified as destructive, are blocked even when allowlisted. A `run_command` not classified as destructive can execute when allowlisted. `fetch_url` mutations (POST, PUT, PATCH, and DELETE) are also blocked. This is not a universal read-only boundary: command classification is heuristic, and even a remote GET can have server-side effects. Do not rely on this mode alone to prevent external side effects.

### Safe tools

These tools are treated as safe by the permission gate and normally do not require confirmation. This designation does not mean they have no side effects (`save_memory` and `update_plan` write Agav state):

`read_file`, `grep_search`, `find_files`, `list_directory`, `web_search`, `lsp_query`, `read_notebook`, `fetch_url` (GET/HEAD only), `overview`, `activate_skill`, `save_memory`, `update_plan`

`fetch_url` mutations require explicit approval for each call, even under `auto-accept` or an `allowedTools` entry. Blanket “always” approval does not authorize them; without a confirmation handler they are refused. See [HTTP request safety](#http-request-safety).

### External tool trust

External agents and MCP tools **cannot** mark themselves as non-destructive to skip confirmation. Only built-in safe tools are trusted with the `destructive: false` flag. All other tools require confirmation in `ask` mode regardless of their declared destructive status.

## Shell sandbox

Agav auto-detects the best available OS-level sandbox at startup:

| Platform | Backend | Mechanism |
| --- | --- | --- |
| macOS | Seatbelt | `sandbox-exec` with deny-default writes and explicit allowances |
| Linux | Bubblewrap | `bwrap` with read-only root, a private workspace snapshot, and credential masking |
| Docker | Container | `--network=none`, memory and CPU limits |
| Windows | Restricted token | Enabled by default: native helper, workspace ACL grants, Job Object |

If no backend is available, `run_command` and `run_tests` are refused when `sandboxRequired` is enabled; otherwise automatic execution is unsandboxed. `sandboxRequired` and `windowsSandbox` both default to `true` on Windows and `false` elsewhere. Set `AGAV_NO_SANDBOX=1` before starting Agav to intentionally disable sandbox detection and permit `run_command` overrides of `sandbox: "none"`. Without that user opt-out, model-requested `none` overrides are rejected, including through skills and subagents. Tool approval, “always”, and auto-accept do not authorize sandbox bypass. Invalid backend values are rejected, and failure to launch a selected sandbox does not retry the command unsandboxed.

The footer shows the **shell default**, not proof of isolation for every tool or command. `run_command` reports the execution backend when it differs from that default. Direct user `!` shell commands intentionally remain unsandboxed with an inherited environment; this does not grant the model the same privilege. These shell policies do not provide OS isolation for native file tools.

The Seatbelt and Bubblewrap sections below describe **`run_command` and `run_tests` execution**. Agent `.mjs` tool processes use separate profiles: their Seatbelt profile is deny-default, blocks network, and allows writes only in the working directory and temp; their Bubblewrap runner uses `--unshare-net`, binds host `/tmp`, and masks existing credential and `.config` directories. Do not assume shell and agent-tool network policies are identical. Bundled agents are trusted and run unsandboxed; global and project agent tools use the available agent sandbox backend.

### Seatbelt (macOS)

The Seatbelt profile denies **all filesystem writes by default**, then restores explicit allowances. Other operations remain broadly allowed subject to the restrictions below; it is not a deny-all capability boundary:

- **Reads** — allowed across the filesystem, except `~/.ssh`, `~/.aws`, and `~/.gnupg`
- **Writes** — allowed only in the working directory, temporary directories, `/dev`, selected Git state paths, and tooling directories (`~/.cache`, `~/.config`, `~/.local`, `~/.npm`, `~/.cargo`). Credential directories remain denied.
- **Protected configuration** — Git config, hooks, and worktree pointers, workspace `.agav`, `.vscode`, `.idea`, and shell startup paths are protected, including names that do not exist yet. Ordinary Git state remains writable.
- **Network** — allowed by default. With an explicit deny policy (see [Network policy](#network-policy)), direct off-host networking is blocked; host-local TCP/IP and Unix sockets remain trusted channels, so local relays can still forward traffic
- **Process execution** — allowed, except `/System/Library/CoreServices`
- **IPC** — Mach lookup, sysctl reads, and POSIX shared memory are allowed for basic process operation

### Bubblewrap (Linux)

- **Filesystem** — root is mounted read-only (`--ro-bind / /`); commands write to a private workspace snapshot, not the live checkout. Changes are validated and published only after a successful, uncancelled command. Publication rejects changes to the protected configuration paths listed above, including previously absent paths.
- **Tooling** — `/tmp`, `~/.cache`, `~/.config`, `~/.npm`, and `~/.cargo` use throwaway scratch mounts. Installed tools under `~/.local` and `~/.rustup` remain visible read-only; `~/.cargo/bin` is restored read-only over the Cargo scratch mount.
- **Credentials** — `~/.ssh`, `~/.aws`, and `~/.gnupg` are replaced with empty tmpfs mounts, hiding their contents
- **Network** — allowed by default. With an explicit deny policy (see [Network policy](#network-policy)), Agav passes `--unshare-net`: loopback reaches only services started within the same command, not host services or other commands
- **Lifecycle** — a private PID namespace (`--unshare-pid`) and `--die-with-parent` prevent background descendants from surviving the invocation.

### Docker

- **Network** — disabled (`--network=none`)
- **Resources** — 512 MB memory, 1 CPU
- **Filesystem** — only the working directory is mounted into the container (at `/workspace`)
- **User** — the container runs as your host UID/GID (`-u uid:gid`) so files written to the working directory stay owned by you. Agav detects the daemon's security mode: under **rootless** Docker (which already maps you to the host user via user namespaces) the explicit UID mapping is omitted, and under daemon-level **userns-remap** it adds `--userns=host` so the mapping resolves to the real host user rather than a subordinate UID.

### Windows

#### Restricted-token sandbox

On Windows, `windowsSandbox` and `sandboxRequired` both default to `true`, so `run_command` and `run_tests` use Agav's native restricted-token helper. A missing helper blocks these executions, not Agav startup. Project config cannot change either setting. `run_command` can also request the `windows` backend override when the helper is present.

- **Writes** — commands run under a write-restricted Windows token. A write succeeds only where Agav granted its sandbox identity access: the working directory and a dedicated sandbox temp directory. `TEMP`, `TMP`, and the npm, pip, and Yarn caches point at that temp directory. Writes elsewhere in your profile and on the system are denied.
- **Protected configuration** — inside the workspace, Git hooks and configuration, `.agav`, `.vscode`, `.idea`, and shell startup files (`.bashrc`, `.zshrc`, `.profile`, `.zprofile`, `.bash_profile`, `.envrc`) are denied. Ordinary Git operations still work.
- **Lifecycle** — commands run in a Job Object, so descendants are terminated when the command exits, times out, or is cancelled. Detached background servers do not survive the command.
- **Permission changes** — the grants and denials are entries Agav adds to the permissions of your workspace and the sandbox temp directory. The first command in a large workspace can take longer while Windows applies them. Agav records every location it changes; run `agav --revoke-windows-sandbox` to remove its entries.

Limits:

- **Reads and networking are not confined.** Commands are refused, not run, while `sandboxNetwork` is `deny`; use `run_command` with the Docker override when you need network isolation (`run_tests` has no Docker override).
- Locations that already grant write access to `Everyone` stay writable.
- Protected paths that don't exist yet can't carry a denial, so a command could create one of them.
- In linked Git worktrees whose metadata lives outside the workspace, Git commands that write metadata fail.

If the helper is unavailable or can't start, the command fails; it never falls back to running unsandboxed.

### Background jobs

With `backgroundJobsEnabled`, the `run_background_job` tool starts commands that run **outside** the shell sandbox, with no timeout and full access as your OS user. Each start, schedule create, stop, and schedule revoke is a separate approved action. The prompt shows the full command, directory, and isolation, and an approval stays valid for that exact spec until it changes. `deny-writes` blocks new jobs and schedules but still lets you confirm a stop or revoke. In print and `agav run` mode these actions are refused without an existing grant. See [Background jobs](/features/background-jobs#approval-and-permission-modes).

### Cancellation is not isolation

**Esc** cancels an interactive turn while keeping Agav open; **Ctrl+C** exits unless it copies an active Agav selection. For worker-owned turns, ordinary cancellation and exit request durable, generation-bound cancellation, not synchronous termination. Only `/detach` or the configured detach chord intentionally exits while leaving the worker running; session switches and presentation unmounts do not cancel. See [Keybindings](/reference/keybindings#cancel-versus-exit).

Native and Seatbelt shell commands use process-group cleanup on failure, cancellation, timeout, and orderly exit; successful background children can survive ordinary completion. Cleanup is best-effort and cannot guarantee termination of descendants that detach from the owned group. Bubblewrap uses a private PID namespace, and the Windows sandbox uses a Job Object, so their background descendants do not survive an invocation. Cleanup cannot undo external actions.

Agent subprocesses and Seatbelt/unsandboxed test runners receive cancellation signals without the shell runner's process-group cleanup guarantees. Bubblewrap and Windows sandboxed test runs retain their backend lifecycle isolation. Cancelling an MCP request stops the local wait, not necessarily server-side execution, and does not kill its shared server. Docker cancellation targets the local CLI, not guaranteed container/daemon cleanup. Check remote jobs, containers, and services separately after interruption.

Tool-activated skills receive the parent turn signal, but focused skill entries have no individual cancel handler. Manual-only slash-command skills receive no turn signal. Skill shell blocks execute outside the restricted tool registry but use the default shell sandbox, filtered environment, process-group cleanup, and the skill's cancellation signal when supplied. `fetch_url` uses its own 30-second timeout instead of the turn signal once a request starts. See [Skills](/features/skills#shell-blocks) before trusting executable skill instructions.

### Temporary output privacy

Large tool results may be saved outside the repository in private OS temporary files. They can contain secrets printed by commands or returned by APIs even when environment-variable filtering is enabled. Unix files use mode `0600` and directories `0700`, but the contents are **not encrypted**. Normal exit attempts cleanup; crash leftovers may remain until a later eligible stale-owner sweep. Do not put credentials in command output, and copy needed logs to an appropriately protected location before exiting. See [output limits and retention](/features/built-in-tools#saved-output-paths-and-retention) for quotas and exact cleanup behavior.

### MCP command validation

On Windows, MCP server subprocesses use `shell: true` for `.cmd` shim compatibility. Before spawning, Agav validates both the command and all arguments against a set of blocked shell metacharacters: `` & | < > ^ ; \` $ ( ) { } [ ] ! % " \n \r ``. If any metacharacter is found, the server startup is rejected immediately — preventing shell injection attacks through crafted MCP server configurations.

Single quotes (`'`) are explicitly allowed since they are not dangerous in `cmd.exe`.

On macOS and Linux, `shell: false` is used, so arguments are passed directly to the process without shell interpretation and no validation is needed.

### Credential filtering

Across **all** sandbox backends (including unsandboxed), environment variables whose names match `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, or `AUTH` are stripped before spawning child processes.

### Requiring a sandbox

Set `sandboxRequired: true` in **global** `~/.agav/config.json`, or use `--sandbox-required`, to refuse `run_command` and `run_tests` executions without an OS-level sandbox. It defaults to `true` on Windows and `false` elsewhere. Agav still starts if no backend is available, with a warning; this is an execution-time restriction, not a startup refusal.

```json
{ "sandboxRequired": true }
```

For `run_command`, enforcement checks the *effective* backend: the requested `sandbox` override when given, otherwise the auto-detected backend. `none` is refused even with `AGAV_NO_SANDBOX=1`; an installed override such as `sandbox: "docker"` can still run. `run_tests` uses the auto-detected backend and has no Docker override. Neither tool retries a failed sandbox launch unsandboxed.

Project config cannot set or override `sandboxRequired`. It is not a universal sandbox requirement for every integration: skill shell blocks use the default sandbox but do not pass through this gate, and background-job commands remain outside the sandbox. Workflow job nodes separately refuse fresh starts when the requirement is enabled.

### Network policy

By default, `run_command` and `run_tests` commands under Seatbelt and Bubblewrap can use the network. To block direct off-host networking, opt in with either of the following:

- `--sandbox-network deny` (alias `--sandbox-no-network`) for one invocation
- `"sandboxNetwork": "deny"` in `~/.agav/config.json` for every session

```json
{ "sandboxNetwork": "deny" }
```

`--sandbox-network allow` (alias `--sandbox-allow-network`) restores networking for one invocation when the global config denies it. Agav never rewrites this setting, so an existing explicit value stays in effect. A present but invalid value is treated as `deny`.

Project config (`.agav/config.json`) can't set `sandboxNetwork`. A session or workflow run records the policy in effect when it starts and keeps it when resumed or run by a detached worker. Workflow runs never relax a recorded `deny`. Docker always uses `--network=none`, and commands without a sandbox are not network-confined.

## HTTP request safety

`fetch_url` accepts only HTTP(S) URLs. It blocks loopback, private, reserved, and metadata destinations, rejecting a hostname if **any** DNS result is forbidden. Connections are pinned to a validated address to prevent DNS rebinding. Each redirect is revalidated (at most five redirects); cross-origin redirects strip `Authorization`, `Cookie`, and `Proxy-Authorization` headers.

These checks apply independently of the shell sandbox. They do not make an approved request harmless or prevent side effects at a public service.

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

These patterns match **POSIX/Unix command syntax**. The `git` patterns apply on every platform, but the filesystem, disk, permission, and process examples above are Unix forms. Windows-native equivalents — such as PowerShell `Remove-Item -Recurse -Force`, `rmdir /s`, `del`, `Format-Volume`, or `Stop-Process` — are **not** on this blocklist and are not pre-blocked. On Windows, rely on `ask` mode confirmations and the file-tool path boundaries above rather than this list, and review commands before approving `auto-accept`.

## Secrets and extensions

- Prefer API-key environment variables.
- Saved provider API keys use AES-256-GCM encryption in `~/.agav/config.json`. Plaintext keys entered manually and existing `enc:` values are accepted on load; saving through Agav encrypts the keys. Environment variables take precedence over global configuration; repository-level API keys are rejected.
- Agav does not access macOS Keychain, Linux Secret Service, or Windows Credential Manager. There is no startup credential migration or OS-store authentication dialog. If an older configuration contains a `keychain:` reference, replace it with the actual API key or supply the corresponding environment variable. Previously stored consumer account references require signing in again. Existing OS-store entries are not read or deleted.
- Encryption uses a key derived from the home directory and username, not a user-supplied password. It prevents casual plaintext disclosure but does not protect against someone who can access the files and derive the same key. Restrict filesystem access and prefer environment-provided credentials where appropriate.
- Global-config writers use one shared exclusive-create file lock. Existing locks are **never automatically stolen or renamed**, regardless of age; saves fail closed if they cannot acquire the lock. If a crash leaves `~/.agav/.config.lock` behind, stop **all Agav processes** before manually removing that lock file, then retry. Config writes use an owner-only (`0600`) temporary file followed by atomic rename.
- Vertex AI’s service-account JSON is not an API key and is never encrypted into `config.json` — it is read from the path in `VERTEX_AI_CREDENTIALS_PATH` or `vertexAICredentialsPath`. Keep the file outside the repository, restrict its permissions, and grant the service account only the `roles/aiplatform.user` role it needs.
- Do not commit secrets to `./.agav/config.json`.
- MCP servers and plugins are executable local integrations. Review their source and configuration before enabling them.
- Use narrow CI permissions and `--max-turns` to limit unattended work.
