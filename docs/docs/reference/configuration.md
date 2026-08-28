---
title: Configuration
description: Configure providers, permissions, hooks, tools, themes, and MCP servers
order: 4
---

# Configuration

Agav merges defaults, `~/.agav/config.json`, and `./.agav/config.json` in that order. Environment variables then override provider credentials and Ollama address settings; CLI flags override the active startup values.

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
| `provider` | `anthropic`, `openai`, `gemini`, `vertex-ai`, or `ollama` |
| `model` | Provider-specific model identifier |
| `vertexAICredentialsPath` | Path to a Google Cloud service-account JSON file used by Vertex AI; setting it enables the provider. Supports a leading `~`. Prefer `VERTEX_AI_CREDENTIALS_PATH`. |
| `vertexAILocation` | Vertex AI region, or `global` for the multi-region endpoint (default `global`). Can also be set with `VERTEX_AI_LOCATION`. |
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
| `mcpServers` | Named stdio MCP server definitions |
| `agentMarketplace` | URL of the agent marketplace (supports `https://` and `file://`). Defaults to the official marketplace. Set `AGAV_MARKETPLACE_URL` to override without editing the config file. |

Project `allowedTools` entries are added to global entries rather than replacing them. The generated top-level `template` object in project configuration is documentation metadata and is removed before runtime merging.
