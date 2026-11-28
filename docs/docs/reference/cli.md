---
title: CLI Reference
description: Startup modes, options, environment variables, and update commands
order: 2
---

# CLI Reference

## Modes

```bash
agav                         # Interactive terminal UI
agav run "prompt"            # Non-interactive agent mode with dynamic context
agav -P "prompt"             # Print one final response and exit
agav update [version]        # Update the installed release
```

### --max-turns

`--max-turns <number>` caps agent iterations **per prompt** across interactive, print (`-P`), and run (`run`) modes.

- Interactive: the cap applies to each user turn in the session. The budget resets for every new prompt and is shared with subagents, named agents, and skills. Tool execution itself does not spend an additional turn.
- Print and run modes: the cap applies across model requests for the one-shot task, including retries.

The value must contain decimal digits only and be between 1 and 9007199254740991; signs, fractions, scientific notation, and hexadecimal notation are rejected. Both `--max-turns 20` and `--max-turns=20` are accepted.

The flag overrides `maxIterations` in configuration for the current session only. On resume, the session history is kept but the cap is reapplied to new prompts.

### --config, -c

`-c key=value` (long form `--config key=value`) overrides a single configuration value for the current session, layered on top of the config files and environment — tweak one setting for one run without editing `~/.agav/config.json`.

```bash
agav -c effort=low -c maxIterations=200
agav -c provider=ollama -P "summarize this repo"
```

- Repeatable; when the same key is given twice, the later one wins.
- Dotted paths set one nested value without touching its siblings: `-c theme.promptColor=blue`. Scalars take a whole value (`-c maxTokens.foo=1` is rejected) and arrays are edited by index (`-c statusBar.0.enabled=false`).
- `true`/`false` and numbers are coerced; object and array values are JSON: `-c 'hooks={"afterEdit":"npm test"}'`.
- Unknown keys, malformed entries, or invalid values fail fast with a clear error, including a "did you mean" hint for typos.
- Dedicated flags still win on conflict (`-c effort=low --effort high` → `high`), and overrides are never written back to `config.json`.
- `agav login`, `agav logout`, `agav job`, `agav mcp`, and `agav workflows` reject `-c` outright: they dispatch before any session exists, so an override would be silently dropped. Use `agav login --control-plane <url>` for enterprise enrollment at a specific control plane.
- Organization-managed policy outranks `-c` on every field it enforces; enforcement keys such as `orgManagedProvider` or `orgPermissionFloor` are rejected outright.

Registered overrides also propagate privately to interactive session workers, using their effective values after dedicated flags and organization policy are applied. See [Detached sessions](/features/detached-sessions#security-and-process-lifetime).

### --provider-idle-timeout

`--provider-idle-timeout <ms>` sets an idle timeout in milliseconds waiting for provider stream activity (positive safe integer from 1 to 2147483647, or `disabled`).

- The idle timer starts when an LLM provider stream attempt begins (bounding time to the first event) and resets on each stream event (text, thinking, tool deltas, usage, retry).
- The idle clock is stopped while tools, user confirmations, and retry backoffs run.
- On expiry, the attempt is aborted, partial text is preserved in history without dispatching incomplete tool calls, and the session remains interactive and ready for subsequent prompts.
- Overrides `providerIdleTimeout` in configuration for the current session. Pass `disabled` or `off` to disable the idle timer and retain provider SDK defaults.

## Options

| Option | Description |
| --- | --- |
| `--provider`, `-p` | `anthropic`, `openai`, `openrouter`, `nvidia`, `deepseek`, `gemini`, `vertex-ai`, or `ollama` |
| `--model`, `-m` | Provider model identifier; the default for a fresh Anthropic configuration is `claude-sonnet-5-5` |
| `--cwd <dir>` | Set the working directory before loading session/project context and resolving relative paths (for example, `agav --cwd "my project"`) |
| `--effort` | `minimal`, `low`, `medium`, `high`, or `max` |
| `--ollama-host` | Ollama host when no complete endpoint is set |
| `--ollama-port` | Ollama port |
| `--ollama-endpoint` | Complete Ollama base URL |
| `--ollama-api-key` | Ollama bearer token |
| `--print`, `-P` | Print mode |
| `--stream` | Stream print-mode response text |
| `--output-schema <json\|@file>` | Validate print-mode output against JSON Schema |
| `--trajectory <path>` | Write a JSON transcript, token usage, and timing for `agav run` or print mode only. See [Trajectory export](/workflows/non-interactive#trajectory-export). |
| `--permission <json>` | JSON tool policy for `agav run` (distinct from the interactive [`/permission`](/reference/slash-commands) session mode) |
| `--max-turns <number>` | Limit the number of agent iterations per prompt in interactive, print, and run modes |
| `--config`, `-c key=value` | Override one config value for the session; repeatable ([details](#--config--c)) |
| `--provider-idle-timeout <ms>` | Idle timeout in milliseconds waiting for provider stream activity (1–2147483647 or `disabled`) |
| `--resume`, `-r [id]` | Open the session picker or resume by exact ID or unique prefix |
| `--name <title>` | Set the initial name for a new interactive session. Interactive mode only; rejected with `-P`/`run`. |
| `--search` | Enable the web search tool for this session |
| `--auto-accept`, `-y` | Skip normal tool confirmations |
| `--openai-api` | OpenAI API mode: `responses` (default) or `chat`. Use `chat` for OpenAI-compatible endpoints that don't support the Responses API. |
| `--deny-writes` | Block write operations |
| `--sandbox-network <deny\|allow>` | Network policy for Seatbelt and Bubblewrap shell commands; default `allow`. Aliases: `--sandbox-no-network`, `--sandbox-allow-network`. See [Network policy](/reference/security#network-policy). |
| `--sandbox-required` | Refuse `run_command` and `run_tests` execution without an OS-level sandbox; see [sandbox enforcement](/reference/security#requiring-a-sandbox). |
| `--revoke-windows-sandbox` | Windows only: remove workspace/temp ACL entries recorded by the native sandbox helper; see [Windows sandbox](/reference/security#windows). |
| `--version`, `-v` | Print the version |
| `--help`, `-h` | Print help |

Both `--option value` and `--option=value` are accepted for provider, model, effort, Ollama values, output schema, permissions, max turns, provider idle timeout, working directory, and trajectory path.
`--config` accepts `--config key=value` and `--config=key=value`; `-c` takes its `key=value` argument as a single token.

## Startup provider and model selection

When you start a plain `agav` session, the provider and model are resolved in this order:

1. **Explicit flags** — `--provider` and `--model` always win. If you pass `--provider` without `--model`, Agav reuses the saved model only when it belongs to that provider, otherwise it falls back to the provider's default model. `-c provider=` and `-c model=` pin the same way against the "last used" rule; when both forms are given, the dedicated flag wins.
2. **Resumed session** — with `--resume`, the session's own provider and model are used unless overridden by a flag.
3. **Last used** — with no flags and no resume, Agav reuses the provider and model from your most recent session, so a new session opens with the same model you last worked in.
4. **Config defaults** — if there is no prior session, the `provider`/`model` in `~/.agav/config.json` (or the built-in default) apply.

> **Windows:** `~/.agav/` paths on this page resolve to `%USERPROFILE%\.agav\`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic credential |
| `OPENAI_API_KEY` | OpenAI credential |
| `OPENROUTER_API_KEY` | OpenRouter credential (`sk-or-v1-...`) |
| `NVIDIA_API_KEY` | NVIDIA NIM credential (`nvapi-...`) |
| `DEEPSEEK_API_KEY` | DeepSeek credential (`sk-...`) |
| `OPENAI_BASE_URL` | Override the OpenAI base URL to target an OpenAI-compatible endpoint |
| `GEMINI_API_KEY` | Gemini credential |
| `VERTEX_AI_CREDENTIALS_PATH` | Path to a Google Cloud service-account JSON file; enables Vertex AI |
| `VERTEX_AI_LOCATION` | Vertex AI region, or `global` for the multi-region endpoint (default `global`) |
| `OLLAMA_ENDPOINT` | Complete Ollama endpoint |
| `OLLAMA_HOST` / `OLLAMA_PORT` | Ollama address components |
| `OLLAMA_API_KEY` | Ollama bearer token |
| `NO_COLOR` | Any defined value disables Agav's color helpers, taking precedence over `FORCE_COLOR`. |
| `FORCE_COLOR` | Force colored output even without a TTY or with `TERM=dumb`. Empty, `0`, or `false` disables it (case-insensitive, surrounding whitespace ignored). |
| `TERM=dumb` | Disable color unless `FORCE_COLOR` enables it. Without an override, color helpers use whether stderr is a TTY. |
| `AGAV_PERMISSION` | JSON policy used by `agav run` |
| `AGAV_NO_UPDATE=1` | Disable automatic update checks |
| `AGAV_NO_SANDBOX=1` | Disable automatic shell sandbox selection |
| `AGAV_MARKETPLACE_URL` | Override the default agent marketplace URL |
| `LIBREOFFICE_PATH` | Office document conversion executable |
| `AGAV_ORG_CONFIG` | Path to an organization-managed policy file (see [Configuration](./configuration#organization-managed-configuration)) |
| `AGAV_ACCOUNT_SERVICE` | Override the consumer account-service URL (not the enterprise control plane) |
| `AGAV_CONTROL_PLANE` | Override the enterprise control-plane URL (not the consumer account service) |
| `AGAV_OIDC_TOKEN` | Pre-supplied OIDC token for `agav login --oidc` in automation |
| `AGAV_AUDIT_SINK` | HTTPS endpoint that receives secret-free `agav login`/`logout` audit events (see [Audit events](#audit-events-siem)) |

## Background job subcommands

Unattended evaluation of [background job schedules](/features/background-jobs#when-schedules-are-evaluated). These read only the global config and require `backgroundJobsEnabled`.

```bash
agav job tick                  # Evaluate due schedules once and exit
agav job tick --install        # Register an OS entry that runs the tick every minute
agav job tick --status         # Show the entry (exit 0 installed, 3 not installed)
agav job tick --uninstall      # Remove the entry; job state is kept
agav job daemon start          # Run a foreground daemon that ticks every 15 seconds
agav job daemon stop           # Stop the running daemon
agav job daemon status         # Exit 0 if running, 3 if not
```

## Agent subcommands

```bash
agav agents                            # Alias for agav agents list
agav agents list                       # List installed agents grouped by origin
agav agents install <url|path>         # Install from URL or local directory
agav agents remove <name>              # Remove from disk
agav agents enable <name>              # Enable a disabled agent
agav agents disable <name>             # Disable without removing files
```

| Option | Description |
| --- | --- |
| `--alias <name>` | Install under an alternative name (resolves name conflicts) |
| `--destination global\|project` | Install scope; defaults to `global` |

Local paths and GitHub repository URLs are both supported for `install`. For GitHub, Agav uses sparse checkout to download only the agent directory.

## Skill subcommands

```bash
agav skills                            # Alias for agav skills list
agav skills list                       # List all skills grouped by origin, with state
agav skills add <url|path>             # Install from a URL or local path
agav skills remove <name>             # Uninstall a global skill
agav skills disable <name>            # Disable a skill (bundled skills included)
agav skills enable <name>             # Re-enable a disabled skill
agav skills clear                     # Remove all user-installed skills
```

Bundled skills are compiled into the binary and cannot be removed, but `disable` turns them off without deleting anything. The enabled/disabled state is stored in `~/.agav/skills/registry.json`. Changes take effect on the next start.

## Session subcommands

```bash
agav sessions delete <id>              # Delete a saved session by ID or unique prefix
agav sessions rm <id>                  # Alias for delete
```

`delete` (and its `rm` alias) accept an exact session ID or a unique ID prefix. An unknown ID returns an error; an ambiguous prefix that matches more than one session is rejected rather than guessing. List session IDs with `--resume` or the `/resume` slash command.

## MCP and workflow subcommands

```text
agav mcp auth <name>       Sign in to a configured OAuth-protected MCP server
agav mcp logout <name>     Remove the server's cached local OAuth credentials
agav workflows help        Show workflow commands and options
```

After CLI MCP sign-in or sign-out, restart running Agav sessions to apply the change. See [MCP](/features/mcp) and the [Workflow reference](/reference/workflows) for setup, consent, and run management.

## Consumer account sign-in

Bare `agav login` signs in to your **personal Agav account**. Create or copy an Agav API key at [agav.dev/account](https://agav.dev/account), run `agav login`, and paste it at the hidden key prompt. With piped input, the CLI reads one key line from stdin instead; feed it from a trusted secret source. Never pass the key as an argument: `--key` and bare key operands are not accepted.

For browser sign-in, start interactive Agav and run [`/login`](/reference/slash-commands#account) to open the wizard. `--account` and `--consumer` explicitly select the consumer flow; `--account-service <url>` overrides `AGAV_ACCOUNT_SERVICE` and the hosted default (`https://agav.dev`). Do not mix these flags with enterprise options. Use `agav logout --account` to clear the local consumer sign-in. Bare `agav logout` is for enterprise enrollment.

## Enterprise login subcommands

For organizations running an Agav control plane, `agav login` with an explicit enterprise flag enrolls a developer: it authenticates through the organization's identity provider, retrieves the enforced [organization policy](./configuration#organization-managed-configuration), and caches it so subsequent sessions apply it.

```bash
agav login --control-plane https://auth.example.com  # Enroll; auto-select the flow
agav login --auth-code                  # Force Authorization Code + PKCE (browser)
agav login --device                     # Force the device flow (SSH / headless)
agav login --oidc                       # Force OIDC token exchange (CI / automation)
agav login --saml                       # Force SAML, brokered by the control plane
agav logout                             # Remove the cached organization policy
```

Options:

| Option | Purpose |
| --- | --- |
| `--control-plane <url>` | Control-plane address. See resolution order below. |
| `--issuer <url>` | Identity-provider issuer for `--auth-code` and `--device`; can come from the control plane’s auth configuration. |
| `--client-id <id>` | OAuth client ID for `--auth-code` and `--device`; can also come from the control plane’s auth configuration. |

**Control-plane address resolution** (highest priority first). For the hosted control plane, select an enterprise flow (for example `agav login --auth-code`) without supplying an address:

1. `--control-plane <url>`
2. the `AGAV_CONTROL_PLANE` environment variable
3. the `controlPlane` value in the organization policy (for a self-hosted control plane, shipped via MDM or a file)
4. `AGAV_DEFAULT_CONTROL_PLANE` if set, otherwise `https://auth.agav.dev`

Flow selection when enterprise enrollment is selected without a flow flag:

- A CI OIDC token source (`AGAV_OIDC_TOKEN`, or a GitHub Actions-style token endpoint) or a non-interactive shell &rarr; **OIDC token exchange**.
- An interactive terminal &rarr; **Authorization Code + PKCE**. If a browser cannot be opened (for example over SSH), rerun with `--device`.

**SAML** is never auto-selected; opt in with `--saml`. It is for organizations whose identity provider speaks SAML 2.0 rather than OIDC. The control plane acts as the SAML Service Provider: Agav opens a browser to the control plane, which runs the SAML dance with the IdP server-side and mints the same identity proof the other flows produce. The CLI never parses SAML, so `--saml` needs no `--issuer`/`--client-id`; it requires only a browser on the local machine.

The flows differ only in how the identity proof is obtained; all exchange it with the control plane for a policy and a short-lived gateway credential, then cache the result (encrypted, owner-only) under `~/.agav/enterprise/`. The control plane is never on the inference path. Restart Agav after login or logout to apply the change.

### Audit events (SIEM)

When an audit sink is configured, enterprise enrollment and sign-out emit a secret-free JSON event per action (`login.attempt`, `login.success`, `login.failure`, `logout`) to the sink via `POST`. Each event carries the action, the login flow, the control-plane origin, the subject (on success), a reason **code** (on failure), an ISO-8601 timestamp, and `source: "agav-cli"` — never an `id_token`, gateway token, authorization code, or PKCE verifier. The failure `reason` is a fixed, allowlisted code (e.g. `unauthorized`, `network_error`, `timed_out`, `cancelled`, `protocol_error`, `error`), never a raw error message — so a message that happens to echo server content can never leak to the SIEM. Full error details still go to local stderr. Emission is best-effort: a slow, unreachable, or misconfigured sink never blocks or fails login.

Configure the sink (an HTTPS endpoint) by either:

- the `auditSink` field in the [organization policy](./configuration#organization-managed-configuration) (admin-shipped; preferred), or
- the `AGAV_AUDIT_SINK` environment variable (local/dev).

With no sink configured, no events are emitted.
