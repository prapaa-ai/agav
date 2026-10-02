---
title: Configuration
description: Configure providers, permissions, hooks, tools, themes, and MCP servers
order: 4
---

# Configuration

Agav merges defaults, `~/.agav/config.json`, and `./.agav/config.json` in that order. Environment variables then override provider credentials and Ollama address settings; CLI flags override the active startup values.

## Precedence

For most settings the effective value is the last one found in this chain:

1. built-in defaults
2. global config — `~/.agav/config.json`
3. project config — `./.agav/config.json`
4. environment variables (credentials and Ollama address settings only)
5. CLI flags (applied at startup)

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
  "permissionMode": "ask",
  "sandboxRequired": false,
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
| `model` | Provider-specific model identifier |
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
| `effort` | `low`, `medium`, `high`, or `max`; invalid values fall back to `medium` |
| `maxTokens` | Maximum output tokens per model response |
| `maxIterations` | Maximum agent/tool iterations; must be a positive integer |
| `errorRetries` | Transient provider retries; must be zero or greater |
| `permissionMode` | `ask`, `auto-accept`, or `deny-writes` |
| `sandboxRequired` | When `true`, refuse to start if no OS-level sandbox (Seatbelt, Bubblewrap, or Docker) is available |
| `allowedTools` | Tool names or scoped patterns that can run without confirmation |
| `systemPrompt` | Additional project instructions |
| `hooks` | Optional commands for `afterEdit`, `afterShell`, and `preCommit` |
| `theme` | Partial terminal color overrides |
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

Prefer environment variables on shared machines. Values in `config.json` are convenient but tied to a single account and easier to leak into backups or version control.

### Project config restrictions

To prevent a malicious repository from redirecting API requests or escalating permissions, the following fields are **ignored in project configuration** and can only be set in global configuration (`~/.agav/config.json`) or via environment variables:

- **Endpoint overrides:** `openaiBaseURL`, `openaiHeaders`, `ollamaEndpoint`, `ollamaHost`, `ollamaPort`
- **API keys:** `anthropicApiKey`, `openaiApiKey`, `openrouterApiKey`, `nvidiaApiKey`, `deepseekApiKey`, `geminiApiKey`, `ollamaApiKey`
- **Permission escalation:** `permissionMode`

These fields are stripped from `./.agav/config.json` before it is merged, so a value placed there is **silently ignored** rather than applied — Agav does not warn about it. This ensures that cloning an untrusted repository cannot silently redirect your credentials to a third-party server or bypass tool confirmations. Set these fields in global config or via environment variables instead.

> **This is not the same as gitignore.** Ignoring `.agav/` in a repository only stops *you* from accidentally committing *your own* project config. It does not protect you when you clone *someone else's* repo: a malicious author can commit a poisoned `./.agav/config.json` anyway (for example with `git add -f`, which overrides `.gitignore`), and it arrives on your disk as a tracked file the moment you clone. Your local `.gitignore` never applies to it. The deny-list above is the actual defense against that clone-and-run threat, because it strips the dangerous fields at load time regardless of how the file got there. Do not rely on gitignore for credential safety.
