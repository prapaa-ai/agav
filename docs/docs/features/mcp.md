---
title: Model Context Protocol
description: Connect Agav to MCP tools, resources, and prompt templates
order: 4
---

# Model Context Protocol

Agav connects to MCP servers over two transport families: **stdio** (local subprocesses communicating through newline-delimited JSON-RPC over stdin/stdout) and **remote** (HTTP or SSE endpoints).

## Stdio servers

Add `mcpServers` to `~/.agav/config.json` or `./.agav/config.json`:

```json
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": {
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

Each server supports a command, optional argument list, and optional environment overrides. Restart Agav after changing server configuration.

## Remote servers (HTTP / SSE)

Remote servers connect to an MCP endpoint over the network instead of spawning a local process. Two transport modes are supported:

- **Streamable HTTP** – the current MCP spec transport. Uses a single HTTP endpoint for both requests and server-initiated messages.
- **Legacy SSE** – the older Server-Sent Events transport. Uses one SSE connection for server-to-client messages and a separate HTTP POST endpoint for client-to-server messages.

When `transport` is omitted, Agav auto-detects: it tries Streamable HTTP first and falls back to Legacy SSE if the server does not support it.

### Basic configuration

```json
{
  "mcpServers": {
    "my-remote-server": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sk-xxx"
      }
    }
  }
}
```

`type: "remote"` is optional when `url` is present — Agav infers the server type automatically.

### Explicit transport selection

If you know which transport the server speaks, pin it with `transport`:

```json
{
  "mcpServers": {
    "legacy-server": {
      "url": "https://mcp.example.com/sse",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer sk-xxx"
      }
    }
  }
}
```

### Remote server config fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | HTTP/SSE endpoint URL |
| `type` | `"remote"` | no | Explicitly marks the server as remote; inferred when `url` is present |
| `transport` | `"http"` or `"sse"` | no | Force a specific transport; omit to auto-detect |
| `headers` | Record\<string, string\> | no | Extra headers sent with every request |

`headers` are sent with every request and are the recommended way to pass authentication tokens. The `command`, `args`, and `env` fields are not used for remote servers.

## Exposed capabilities

- **Tools** are registered in the main tool pool with their server name prefixed to the tool name and shown in the description. MCP tools are not in the built-in safe list, so they **require user confirmation** before each call unless you are in `auto-accept` mode or the tool is explicitly allowed via `--permission`.
- **Resources** are summarized in model context and read on demand through `mcp_read_resource`.
- **Prompts** become slash commands. Agav requests the rendered prompt from the owning server and submits its messages to the conversation.

If one server fails to start, Agav continues without it. Run `/debug` to see connected server names and counts for discovered resources and prompts.

## Live refresh

When a connected server sends `notifications/tools/list_changed`, `notifications/resources/list_changed`, or `notifications/prompts/list_changed`, Agav re-fetches the corresponding catalog from that server and updates the session immediately — no restart needed. This only applies to changes the server advertises at runtime; edits to `config.json` itself still require a restart.

## Related

- [Research GitHub with an MCP Server](/guides/mcp) — practical walkthrough using the GitHub MCP server

