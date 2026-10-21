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

- Interactive: the cap applies to each user turn in the session. The budget resets for every new prompt and is shared with subagents, skills, and tool calls.
- Print mode: a single prompt runs with the cap; when reached the agent summarizes its work and stops.
- Run mode: the cap limits internal model/tool iterations for the task prompt.

The flag overrides `maxIterations` in configuration for the current session only. On resume, the session history is kept but the cap is reapplied to new prompts.

## Options

| Option | Description |
| --- | --- |
| `--provider`, `-p` | `anthropic`, `openai`, `openrouter`, `nvidia`, `deepseek`, `gemini`, `vertex-ai`, or `ollama` |
| `--model`, `-m` | Provider model identifier |
| `--effort` | `low`, `medium`, `high`, or `max` |
| `--ollama-host` | Ollama host when no complete endpoint is set |
| `--ollama-port` | Ollama port |
| `--ollama-endpoint` | Complete Ollama base URL |
| `--ollama-api-key` | Ollama bearer token |
| `--print`, `-P` | Print mode |
| `--stream` | Stream print-mode response text |
| `--output-schema <json\|@file>` | Validate print-mode output against JSON Schema |
| `--permission <json>` | Tool policy for `agav run` |
| `--max-turns <number>` | Limit the number of agent iterations per prompt in interactive, print, and run modes |
| `--resume`, `-r [id]` | Open the session picker or resume by ID prefix |
| `--auto-accept`, `-y` | Skip normal tool confirmations |
| `--openai-api` | OpenAI API mode: `responses` (default) or `chat`. Use `chat` for OpenAI-compatible endpoints that don't support the Responses API. |
| `--deny-writes` | Block write operations |
| `--version`, `-v` | Print the version |
| `--help`, `-h` | Print help |

Both `--option value` and `--option=value` are accepted for provider, model, effort, Ollama values, output schema, permissions, and max turns.

## Startup provider and model selection

When you start a plain `agav` session, the provider and model are resolved in this order:

1. **Explicit flags** — `--provider` and `--model` always win. If you pass `--provider` without `--model`, Agav reuses the saved model only when it belongs to that provider, otherwise it falls back to the provider's default model.
2. **Resumed session** — with `--resume`, the session's own provider and model are used unless overridden by a flag.
3. **Last used** — with no flags and no resume, Agav reuses the provider and model from your most recent session, so a new session opens with the same model you last worked in.
4. **Config defaults** — if there is no prior session, the `provider`/`model` in `~/.agav/config.json` (or the built-in default) apply.

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
| `AGAV_PERMISSION` | JSON policy used by `agav run` |
| `AGAV_NO_UPDATE=1` | Disable automatic update checks |
| `AGAV_NO_SANDBOX=1` | Disable automatic shell sandbox selection |
| `AGAV_MARKETPLACE_URL` | Override the default agent marketplace URL |
| `LIBREOFFICE_PATH` | Office document conversion executable |
| `AGAV_ORG_CONFIG` | Path to an organization-managed policy file (see [Configuration](./configuration#organization-managed-configuration)) |
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

## Enterprise login subcommands

For organizations running an Agav control plane, `agav login` enrolls a developer: it authenticates through the organization's identity provider, retrieves the enforced [organization policy](./configuration#organization-managed-configuration), and caches it so subsequent sessions apply it.

```bash
agav login                              # Sign in; auto-selects the login flow
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
| `--issuer <url>` | Identity-provider issuer (required for `--auth-code` and `--device`). |
| `--client-id <id>` | OAuth client id registered for the Agav CLI (required for interactive flows). |

**Control-plane address resolution** (highest priority first). You do not need to set any of these for the hosted service — `agav login` works out of the box against Agav's hosted control plane:

1. `--control-plane <url>`
2. the `AGAV_CONTROL_PLANE` environment variable
3. the `controlPlane` value in the organization policy (for a self-hosted control plane, shipped via MDM or a file)
4. Agav's built-in hosted default

Flow selection when none is forced:

- A CI OIDC token source (`AGAV_OIDC_TOKEN`, or a GitHub Actions-style token endpoint) or a non-interactive shell &rarr; **OIDC token exchange**.
- An interactive terminal &rarr; **Authorization Code + PKCE**. If a browser cannot be opened (for example over SSH), rerun with `--device`.

**SAML** is never auto-selected; opt in with `--saml`. It is for organizations whose identity provider speaks SAML 2.0 rather than OIDC. The control plane acts as the SAML Service Provider: Agav opens a browser to the control plane, which runs the SAML dance with the IdP server-side and mints the same identity proof the other flows produce. The CLI never parses SAML, so `--saml` needs no `--issuer`/`--client-id`; it requires only a browser on the local machine.

The flows differ only in how the identity proof is obtained; all exchange it with the control plane for a policy and a short-lived gateway credential, then cache the result (encrypted, owner-only) under `~/.agav/enterprise/`. The control plane is never on the inference path. Restart Agav after login or logout to apply the change.

### Audit events (SIEM)

When an audit sink is configured, `agav login`/`agav logout` emit a secret-free JSON event per action (`login.attempt`, `login.success`, `login.failure`, `logout`) to the sink via `POST`. Each event carries the action, the login flow, the control-plane origin, the subject (on success), a reason **code** (on failure), an ISO-8601 timestamp, and `source: "agav-cli"` — never an `id_token`, gateway token, authorization code, or PKCE verifier. The failure `reason` is a fixed, allowlisted code (e.g. `unauthorized`, `network_error`, `timed_out`, `cancelled`, `protocol_error`, `error`), never a raw error message — so a message that happens to echo server content can never leak to the SIEM. Full error details still go to local stderr. Emission is best-effort: a slow, unreachable, or misconfigured sink never blocks or fails login.

Configure the sink (an HTTPS endpoint) by either:

- the `auditSink` field in the [organization policy](./configuration#organization-managed-configuration) (admin-shipped; preferred), or
- the `AGAV_AUDIT_SINK` environment variable (local/dev).

With no sink configured, no events are emitted.
