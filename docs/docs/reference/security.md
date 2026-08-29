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

### deny-writes mode

In `deny-writes` mode, all file-mutating tools (`edit_file`, `write_file`, `run_command`, `edit_notebook`) are blocked unconditionally — even if they appear in the `allowedTools` list. This prevents a blanket allowlist grant from quietly authorising destructive operations.

### Safe tools

These tools never require confirmation because they cannot modify the working tree:

`read_file`, `grep_search`, `find_files`, `list_directory`, `web_search`, `lsp_query`, `read_notebook`, `fetch_url`, `overview`, `activate_skill`, `save_memory`, `update_plan`

### External tool trust

External agents and MCP tools **cannot** mark themselves as non-destructive to skip confirmation. Only built-in safe tools are trusted with the `destructive: false` flag. All other tools require confirmation in `ask` mode regardless of their declared destructive status.

## Shell sandbox

Agav auto-detects the best available OS-level sandbox at startup:

| Platform | Backend | Mechanism |
| --- | --- | --- |
| macOS | Seatbelt | `sandbox-exec` with a deny-default profile |
| Linux | Bubblewrap | `bwrap` with read-only root and network isolation |
| Docker | Container | `--network=none`, memory and CPU limits |
| Windows | Env-var shaping | Strips proxy vars, sets `AGAV_SANDBOX_ACTIVE=1` |

If no backend is available, commands run unsandboxed. Set `AGAV_NO_SANDBOX=1` to intentionally disable sandbox detection.

### Seatbelt (macOS)

The Seatbelt profile uses **deny-default** with targeted allows:

- **Reads** — allowed across the filesystem, except `~/.ssh`, `~/.aws`, and `~/.gnupg`
- **Writes** — allowed only in the working directory and system temp directory
- **Network** — fully denied
- **Process execution** — allowed, except `/System/Library/CoreServices`
- **IPC** — Mach lookup, sysctl reads, and POSIX shared memory are allowed for basic process operation

### Bubblewrap (Linux)

- **Filesystem** — root is mounted read-only (`--ro-bind / /`); only the working directory and `/tmp` are writable
- **Credentials** — `~/.ssh`, `~/.aws`, `~/.gnupg`, and `~/.config` are replaced with empty tmpfs mounts
- **Network** — fully isolated (`--unshare-net`)
- **Lifecycle** — child processes are killed when Agav exits (`--die-with-parent`)

### Docker

- **Network** — disabled (`--network=none`)
- **Resources** — 512 MB memory, 1 CPU
- **Filesystem** — only the working directory is mounted into the container

### Windows

Windows has no kernel-level sandbox. As a best-effort mitigation, Agav:

- Sets `AGAV_SANDBOX_ACTIVE=1` so well-behaved child tools can self-restrict
- Strips `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lowercase variants) to reduce network reach

### MCP command validation

On Windows, MCP server subprocesses use `shell: true` for `.cmd` shim compatibility. Before spawning, Agav validates both the command and all arguments against a set of blocked shell metacharacters: `` & | < > ^ ; \` $ ( ) { } [ ] ! % " \n \r ``. If any metacharacter is found, the server startup is rejected immediately — preventing shell injection attacks through crafted MCP server configurations.

Single quotes (`'`) are explicitly allowed since they are not dangerous in `cmd.exe`.

On macOS and Linux, `shell: false` is used, so arguments are passed directly to the process without shell interpretation and no validation is needed.

### Credential filtering

Across **all** sandbox backends (including unsandboxed), environment variables whose names match `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, or `AUTH` are stripped before spawning child processes.

### Requiring a sandbox

Use `--sandbox-required` or set `sandboxRequired: true` in configuration to make Agav refuse to start if no OS-level sandbox backend is available. This is recommended for CI, automation, and shared environments.

```bash
agav --sandbox-required run "deploy to staging"
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

- `~/.ssh/`
- `~/.aws/`
- `~/.gnupg/`
- `~/.kube/config`

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

## Secrets and extensions

- Prefer API-key environment variables.
- Saved provider credentials are encrypted with AES-256-GCM before being written to global configuration.
- Vertex AI’s service-account JSON is not an API key and is never encrypted into `config.json` — it is read from the path in `VERTEX_AI_CREDENTIALS_PATH` or `vertexAICredentialsPath`. Keep the file outside the repository, restrict its permissions, and grant the service account only the `roles/aiplatform.user` role it needs.
- Do not commit secrets to `./.agav/config.json`.
- MCP servers and plugins are executable local integrations. Review their source and configuration before enabling them.
- Use narrow CI permissions and `--max-turns` to limit unattended work.
