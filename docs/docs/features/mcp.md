---
title: Model Context Protocol
description: Connect Agav to MCP tools, resources, and prompt templates
order: 4
---

# Model Context Protocol

Agav starts configured MCP servers as local subprocesses and communicates through newline-delimited JSON-RPC over stdin and stdout.

## Configure a server

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

## Exposed capabilities

- **Tools** are registered in the main tool pool with their server name in the description.
- **Resources** are summarized in model context and read on demand through `mcp_read_resource`.
- **Prompts** become slash commands. Agav requests the rendered prompt from the owning server and submits its messages to the conversation.

If one server fails to start, Agav continues without it. Run `/debug` to see connected server names and counts for discovered resources and prompts.

Agav currently documents stdio subprocess configuration; it does not expose an HTTP/SSE server configuration shape.
