---
title: Configuration
description: Configure providers, permissions, hooks, tools, themes, and MCP servers
order: 4
---

# Configuration

Agav merges defaults, `~/.agav/config.json`, and `./.agav/config.json` in that order. Environment variables then override provider credentials and Ollama address settings, `-c key=value` session overrides layer on top of the result, dedicated CLI flags win over those, and organization-managed policy wins over everything (see Precedence).

## Precedence

For most settings the effective value is the last one found in this chain:

1. built-in defaults
2. global config — `~/.agav/config.json`
3. project config — `./.agav/config.json`
4. environment variables (credentials and Ollama address settings only)
5. session overrides — `-c key=value` (repeatable; see the [CLI reference](/reference/cli))
6. dedicated CLI flags (applied at startup)
7. organization-managed config (see [Organization-managed configuration](#organization-managed-configuration)) — applied **last** and **not overridable** by the user

When an administrator ships an organization policy, its enforced fields win over every source above, including environment variables and CLI flags. A user can make a setting *stricter* (for example choosing a more restrictive `permissionMode`) but cannot loosen or bypass an org-enforced value.

Provider credentials and endpoint overrides are resolved separately and follow a **stricter** chain, because the sensitive fields listed under [Project config restrictions](#project-config-restrictions) are stripped from project config before merging. For each API key the effective value is the first one found in:

1. the provider's environment variable (e.g. `OPENAI_API_KEY`)
2. **global** config `~/.agav/config.json`
3. built-in default (normally empty)

Because the key fields are removed from project config, a value like `openaiApiKey` placed in `./.agav/config.json` is **silently ignored** — it never reaches the provider. Set keys via the environment variable or in global config only.

> **Windows:** `~/.agav/` resolves to `%USERPROFILE%\.agav\` (typically `C:\Users\<username>\.agav\`). This applies to all `~/.agav/` paths throughout the documentation.

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "effort": "medium",
  "maxTokens": 16384,
  "maxIterations": 800,
  "errorRetries": 5,
  "providerIdleTimeout": 60000,
  "permissionMode": "ask",
  "allowedTools": ["read_file", "run_command:npm run *"],
  "systemPrompt": "Follow the conventions documented in this repository.",
  "hooks": {
    "afterEdit": "npm run typecheck",
    "afterShell": "git status --short",
    "preCommit": "npm test"
  },
  "theme": {
    "userLabel": "blue",
    "agentLabel": "magenta",
    "promptColor": "green"
  },
  "mcpServers": {}
}
```

## Fields

| Field | Values or behavior |
| --- | --- |
| `provider` | `anthropic`, `openai`, `openrouter`, `nvidia`, `deepseek`, `gemini`, `vertex-ai`, or `ollama` |
| `model` | Provider-specific model identifier. Fresh Anthropic configurations default to `claude-sonnet-5-5`. |
| `anthropicApiKey` | Anthropic API key. Global config only — encrypted at rest. Prefer `ANTHROPIC_API_KEY`. |
| `openaiApiKey` | OpenAI API key. Global config only — encrypted at rest. Prefer `OPENAI_API_KEY`. |
| `openrouterApiKey` | OpenRouter API key. Global config only — encrypted at rest. Prefer `OPENROUTER_API_KEY`. |
| `nvidiaApiKey` | NVIDIA NIM API key. Global config only — encrypted at rest. Prefer `NVIDIA_API_KEY`. |
| `deepseekApiKey` | DeepSeek API key. Global config only — encrypted at rest. Prefer `DEEPSEEK_API_KEY`. |
| `geminiApiKey` | Google Gemini API key. Global config only — encrypted at rest. Prefer `GEMINI_API_KEY`. |
| `openaiApi` | OpenAI wire protocol: `responses` (default) or `chat` (for OpenAI-compatible endpoints that only speak Chat Completions). Also settable with `--openai-api`. |
| `openaiBaseURL` | Override the OpenAI base URL to target an OpenAI-compatible endpoint (private gateway, self-hosted deployment). Applies only to the `openai` provider. Global config only. Prefer `OPENAI_BASE_URL`. |
| `openaiHeaders` | Extra HTTP headers sent with every `openai`-provider request. Useful for OpenAI-compatible gateways that need custom auth or routing headers. Global config only. |
| `vertexAICredentialsPath` | Path to a Google Cloud service-account JSON file used by Vertex AI; setting it enables the provider. Supports a leading `~`. Prefer `VERTEX_AI_CREDENTIALS_PATH`. |
| `vertexAILocation` | Vertex AI region, or `global` for the multi-region endpoint (default `global`). Can also be set with `VERTEX_AI_LOCATION`. |
| `ollamaEndpoint` | Complete Ollama API base URL; overrides `ollamaHost` and `ollamaPort`. Global config only. Prefer `OLLAMA_ENDPOINT`. |
| `ollamaHost` | Ollama server hostname, used when `ollamaEndpoint` is unset. Global config only. Prefer `OLLAMA_HOST`. |
| `ollamaPort` | Ollama server port, used when `ollamaEndpoint` is unset. Global config only. Prefer `OLLAMA_PORT`. |
| `ollamaApiKey` | Optional bearer token for a secured or hosted Ollama endpoint. Global config only — encrypted at rest. Prefer `OLLAMA_API_KEY`. |
| `hideAbsolutePath` | When `true`, hide absolute paths in terminal output, showing relative paths instead |
| `showThinking` | When `true`, stream the model's reasoning text (toggle at runtime with Ctrl+T) |
| `effort` | `minimal`, `low`, `medium`, `high`, or `max`; invalid values fall back to `medium` |
| `maxTokens` | Maximum output tokens per model response |
| `maxIterations` | Maximum agent/tool iterations per prompt; must be a positive integer; can be overridden at startup with `--max-turns` or `-c maxIterations` for the current session |
| `errorRetries` | Transient provider retries; must be zero or greater |
| `providerIdleTimeout` | Idle timeout in milliseconds waiting for provider stream activity (positive safe integer 1–2147483647). When unset, `null`, or `"disabled"`, Agav adds no timer and retains provider SDK defaults. Can be overridden at startup with `--provider-idle-timeout`. |
| `permissionMode` | `ask`, `auto-accept`, or `deny-writes` |
| `sandboxRequired` | Refuse `run_command` and `run_tests` executions without an OS-level sandbox; does not prevent startup. Default `true` on Windows, `false` elsewhere. Global config only. See [Requiring a sandbox](/reference/security#requiring-a-sandbox). |
| `sandboxNetwork` | Network policy for Seatbelt and Bubblewrap `run_command` and `run_tests` executions: `allow` (default) or `deny` to block direct off-host networking. Global config only; invalid values are treated as `deny`. See [Network policy](/reference/security#network-policy). |
| `windowsSandbox` | Run shell/test commands under Agav's Windows restricted-token helper, confining writes to the workspace and a sandbox temp directory. Reads and networking are not confined; execution is refused under `sandboxNetwork: "deny"`. Default `true` on Windows, `false` elsewhere; global config only. A missing helper blocks execution with the default `sandboxRequired: true`, not startup. See [Restricted-token sandbox](/reference/security#restricted-token-sandbox). |
| `allowedTools` | Tool names or scoped patterns that can run without confirmation |
| `search` | When `true`, enable the `web_search` tool (off by default). Also settable per session with `--search`. See [Built-in tools](/features/built-in-tools). |
| `systemPrompt` | Additional project instructions |
| `backgroundJobsEnabled` | Opt in (default `false`) to `run_background_job`, `/job`, and worker-owned ordinary interactive turns with `/detach`. Set `true` before starting the task; no separate flag is needed for detached sessions. Shell jobs run outside the shell sandbox; session tools retain their permission and sandbox policy. See [Background jobs](/features/background-jobs) and [Detached sessions](/features/detached-sessions). |
| `workflowsEnabled` | Opt in to JSON/YAML workflows (default `false`). Requires `backgroundJobsEnabled: true`. Set it in global config, not project config. See the [Workflow reference](/reference/workflows). |
| `maxConcurrentWorkflowRuns` | Maximum simultaneous workflow runs (default `2`); additional runs wait in the queue. |
| `backgroundAutomation` | `on` (default) or `paused`. `paused` makes `agav job tick` and `agav job daemon` do nothing. Global config only. |
| `hooks` | Optional commands for `afterEdit`, `afterShell`, and `preCommit` |
| `theme` | Partial terminal color overrides |
| `statusBar` | Footer (status bar) layout: which segments appear and in what order. Managed interactively with [`/customize`](/reference/slash-commands); a saved layout is reconciled against the current segment catalog on each start, so newer or older builds never corrupt the footer. |
| `mcpServers` | Named MCP server definitions (stdio and remote) |
| `agentMarketplace` | URL of the agent marketplace (supports `https://` and `file://`). Defaults to the official marketplace. Set `AGAV_MARKETPLACE_URL` to override without editing the config file. |

### MCP server fields

**Stdio servers** (local subprocess):

| Field | Type | Description |
| --- | --- | --- |
| `command` | string | Executable to run (e.g. `npx`, `uvx`, `docker`) |
| `args` | string[] | Arguments passed to the command |
| `env` | Record<string, string> | Environment variables for the subprocess |

**Remote servers** (HTTP/SSE):

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | HTTP/SSE endpoint URL |
| `type` | `"remote"` | Marks the entry as a remote server; inferred when `url` is present |
| `transport` | `"http"` \| `"sse"` | Force a specific transport; omit to auto-detect (tries HTTP first, falls back to SSE) |
| `headers` | Record<string, string> | Extra headers sent with every request (e.g. `Authorization`) |

Project `allowedTools` entries are added to global entries rather than replacing them. The generated top-level `template` object in project configuration is documentation metadata and is removed before runtime merging.

### Provider credentials

Each provider reads its credential from one of two places: the matching environment variable, or the `*ApiKey` field in **global** config (`~/.agav/config.json`). The environment variable always wins when both are set.

| Config field | Environment variable | Notes |
| --- | --- | --- |
| `anthropicApiKey` | `ANTHROPIC_API_KEY` | |
| `openaiApiKey` | `OPENAI_API_KEY` | |
| `openrouterApiKey` | `OPENROUTER_API_KEY` | |
| `nvidiaApiKey` | `NVIDIA_API_KEY` | |
| `deepseekApiKey` | `DEEPSEEK_API_KEY` | |
| `geminiApiKey` | `GEMINI_API_KEY` | |
| `ollamaApiKey` | `OLLAMA_API_KEY` | Optional; only for secured/hosted Ollama |
| _(no field)_ | `VERTEX_AI_CREDENTIALS_PATH` | Path to a service-account JSON file — see below |

When a key is saved to global config (for example through the setup flow), Agav encrypts it with AES-256-GCM before writing the file, so `config.json` never stores a plaintext secret. Keys are decrypted in memory only when a session starts. Environment-variable keys are used as provided and are never written to disk.

Vertex AI is the exception: it authenticates with a service-account JSON file referenced by `vertexAICredentialsPath` (or `VERTEX_AI_CREDENTIALS_PATH`), not an API key, and that file is **never** encrypted into `config.json`. Protect it yourself — see [Connect a Provider](/getting-started/providers).

Set shell environment variables before launching Agav. For example, to point the OpenAI provider at a local compatible server:

**POSIX shell**

```bash
export OPENAI_BASE_URL="http://localhost:1234/v1"
```

**Windows PowerShell**

```powershell
$env:OPENAI_BASE_URL = 'http://localhost:1234/v1'
```

These examples configure the shell that launches Agav, not the shell Agav uses for tools. See [Files and Context](/workflows/files-and-context#run-a-shell-command) for the distinction.

Personal Agav account sign-in stores an encrypted record in `~/.agav/account/account.json`, separate from provider credentials and enterprise policy. Sign-in does not replace provider configuration. See [Consumer account sign-in](/reference/cli#consumer-account-sign-in).

Prefer environment variables on shared machines. Values in `config.json` are convenient but tied to a single account and easier to leak into backups or version control.

### Project config restrictions

To prevent a malicious repository from redirecting API requests or escalating permissions, the following fields are **ignored in project configuration** and can only be set in global configuration (`~/.agav/config.json`), via environment variables, or from your own command line with `-c` (explicit user intent, session-only):

- **Endpoint overrides:** `openaiBaseURL`, `openaiHeaders`, `ollamaEndpoint`, `ollamaHost`, `ollamaPort`
- **API keys:** `anthropicApiKey`, `openaiApiKey`, `openrouterApiKey`, `nvidiaApiKey`, `deepseekApiKey`, `geminiApiKey`, `ollamaApiKey`
- **Permission escalation:** `permissionMode`
- **Sandbox policy:** `sandboxRequired`, `sandboxNetwork`, `windowsSandbox`
- **Automation opt-in and unattended scheduling:** `workflowsEnabled`, `backgroundAutomation`
- **Enterprise routing:** `controlPlane`, `auditSink` (use the organization policy or their documented CLI/environment options, not user config)

These fields are stripped from `./.agav/config.json` before it is merged, so a value placed there is **silently ignored** rather than applied — Agav does not warn about it. This ensures that cloning an untrusted repository cannot silently redirect your credentials to a third-party server or bypass tool confirmations. Use the supported global, environment, or CLI setting for each field.

> **This is not the same as gitignore.** Ignoring `.agav/` in a repository only stops *you* from accidentally committing *your own* project config. It does not protect you when you clone *someone else's* repo: a malicious author can commit a poisoned `./.agav/config.json` anyway (for example with `git add -f`, which overrides `.gitignore`), and it arrives on your disk as a tracked file the moment you clone. Your local `.gitignore` never applies to it. The deny-list above is the actual defense against that clone-and-run threat, because it strips the dangerous fields at load time regardless of how the file got there. Do not rely on gitignore for credential safety.

## Organization-managed configuration

Organizations can enforce a policy that takes precedence over every other configuration source and that users cannot loosen. This is the mechanism IT or a platform team uses to pin a gateway, restrict which providers and models developers may use, and set a minimum permission level across a fleet.

### Where the policy comes from

Agav looks for an administrator-provided policy file in this order:

1. the path named by the `AGAV_ORG_CONFIG` environment variable
2. a known system path:
   - **macOS:** `/Library/Application Support/Agav/org-config.json`, then `/etc/agav/org-config.json`
   - **Linux:** `/etc/agav/org-config.json`
   - **Windows:** `%ProgramData%\Agav\org-config.json`

Deliver the file through your device-management (MDM) tooling or your fleet provisioning. If there is no file or cached policy, no organization policy is enforced.

If no policy file exists, Agav falls back to policy cached by [enterprise enrollment](/reference/cli#enterprise-login-subcommands). A present but unreadable or invalid file is a policy error, not a reason to fall back.

### What a policy can enforce

```json
{
  "provider": "openai",
  "model": "gpt-5.4",
  "openaiBaseURL": "https://gateway.corp.example/v1",
  "openaiHeaders": { "x-tenant": "team-a" },
  "permissionMode": "ask",
  "allowedProviders": ["openai", "anthropic"],
  "allowedModels": ["gpt-5.4", "claude-sonnet-4"],
  "allowedTools": ["read_file", "grep_search"],
  "controlPlane": "https://auth.corp.example"
}
```

| Field | Effect |
| --- | --- |
| `provider`, `model` | **Hard pin** — the org value is used regardless of user config. |
| `openaiBaseURL`, `openaiHeaders` | **Hard pin** — route all OpenAI-compatible traffic through the organization's gateway. |
| `permissionMode` | **Floor** — the user may choose a *stricter* mode but never a looser one (strictness order: `deny-writes` > `ask` > `auto-accept`). |
| `allowedProviders` | **Allowlist** — selecting a provider outside the list is rejected at startup. Omit the list for no restriction; an explicit empty list is rejected. |
| `allowedModels` | **Allowlist** — selecting a model outside the list is rejected at startup. Omit the list for no restriction; an explicit empty list is rejected. |
| `allowedTools` | **Additive** — the org's required tools are merged with the user's allowlist. |
| `controlPlane` | Address of a self-hosted control plane used by enterprise enrollment. Optional — omit it to use Agav's hosted control plane. |
| `auditSink` | HTTPS endpoint that receives secret-free `agav login`/`logout` audit events for your SIEM. Optional. See [Audit events](./cli#audit-events-siem). |

### How enforcement behaves

- Enforced fields are applied **after** global config, project config, environment variables, and CLI flags, so none of those can override them.
- Choosing a provider or model outside an allowlist produces a clear policy error at startup (reported before any missing-credential message), rather than silently falling back.
- `permissionMode` is treated as a minimum: a developer can tighten it locally but cannot drop below the org floor.

> The organization policy is a *delivery mechanism* for enforcement. The same policy shape can be delivered by authenticated enterprise enrollment instead of a file; the enforcement behavior is identical regardless of source.
