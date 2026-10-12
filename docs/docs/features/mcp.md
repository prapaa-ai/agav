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

`headers` are sent with every request and can pass static authentication tokens. Explicit `Authorization` headers take precedence over OAuth. The `command`, `args`, and `env` fields are not used for remote servers.

## OAuth authentication

Agav discovers OAuth requirements when a remote MCP server returns a Bearer authentication challenge. Startup and tool requests never launch browser sign-in automatically. Cached tokens are reused or refreshed silently; servers needing sign-in are summarized in one startup warning. Run `/mcp` to view connected servers and those requiring authentication, then explicitly run `/mcp auth <name>` to open your browser, complete the PKCE authorization flow, and connect that server without restarting. Other configured servers connect independently.

For example, add Figma's remote server to `./.agav/config.json`:

```json
{
  "mcpServers": {
    "figma": {
      "url": "https://mcp.figma.com/mcp",
      "transport": "http"
    }
  }
}
```

**Figma remote access limitation:** Figma currently rejects Agav's dynamic client registration with `403 Forbidden` before browser sign-in. OAuth support alone does not bypass provider client restrictions. Remote access may require Figma to approve Agav; using another product's client identity is not a supported workaround. The remote configuration above shows the endpoint, but is not a verified working Agav/Figma integration.

If your account supports Figma's [desktop MCP server](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/), enable it in the Figma desktop app and use its local endpoint instead:

```json
{
  "mcpServers": {
    "figma": {
      "url": "http://127.0.0.1:3845/mcp",
      "transport": "http"
    }
  }
}
```

The desktop server has different availability and capabilities from the remote server. Keep Figma running and restart Agav after changing configuration.

For servers that accept Agav's client registration, you can also sign in explicitly before starting Agav:

```bash
agav mcp auth figma
```

Standalone CLI sign-in does not require an LLM provider. Restart Agav after using `agav mcp auth <name>`. In an existing Agav session, `/mcp auth <name>` reconnects immediately; success feedback names the connected server and reports how many still require authentication. The startup warning updates as servers connect and disappears when none remain. Failed, denied, or canceled sign-in never reports success. If OAuth succeeds but MCP discovery fails, the error distinguishes those outcomes.

Startup never launches a new browser login, whether interactive or not; it reuses cached credentials, refreshes tokens when possible, or reports the command needed to sign in. The sign-in timeout defaults to five minutes, separate from normal MCP request timeouts. Ctrl+C cancels standalone CLI sign-in; the normal interrupt/cancel shortcut cancels in-session sign-in. Duplicate sign-in requests for the same server are rejected while one is pending.

OAuth tokens and registered client credentials are encrypted using Agav's existing local encryption utility and stored in private, atomically replaced files under `~/.agav/mcp-auth/`, not in project configuration. This is local encryption, not an operating-system keychain. Cache entries are isolated by server name, URL, authentication settings, and configured headers. Treat this directory as sensitive. Expired tokens are refreshed automatically; revoked credentials may require sign-in again.

To remove a server's cached credentials:

```bash
agav mcp logout figma
```

Restart running Agav sessions after standalone CLI logout. In an existing session, run `/mcp logout <name>` instead: it immediately disconnects that server, removes its tools/resources/prompt commands, cancels any pending sign-in, and deletes its cached OAuth credentials without restarting. Other servers stay connected. Run `/mcp auth <name>` to sign in again.

Logout removes local credentials; it does not revoke grants at the provider. Servers with an explicit `Authorization` header or `oauth: false` cannot use in-session OAuth logout: remove their configured credentials instead. Stdio servers do not support OAuth logout.

Optional remote-server configuration:

| Field | Description |
| --- | --- |
| `oauth: false` | Disable automatic OAuth for this server. |
| `oauth.clientId` | Use a pre-registered public client ID instead of dynamic registration. |
| `oauth.issuer` | Use and validate a specific authorization-server issuer. |
| `oauth.scopes` | Array of requested scopes. |
| `oauth.callbackPort` | Fixed loopback callback port; omitted or zero allocates and remembers a port. |
| `oauth.timeoutSeconds` | Positive sign-in timeout; defaults to 300. |

OAuth endpoints must use HTTPS, except for loopback development servers. Redirects and cross-origin MCP POST endpoints are rejected to avoid leaking credentials. Servers must support dynamic registration or a configured public client ID. Agav supports the authorization-code flow, not device-code or client-credentials grants.

See [Figma's remote MCP setup](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) for Figma account and access requirements.

## Exposed capabilities

- **Tools** are registered in the main tool pool with their server name prefixed to the tool name and shown in the description. MCP tools are not in the built-in safe list, so they **require user confirmation** before each call unless you are in `auto-accept` mode or the tool is explicitly allowed via `--permission`.
- **Resources** are summarized in model context and read on demand through `mcp_read_resource`.
- **Prompts** become slash commands. Agav requests the rendered prompt from the owning server and submits its messages to the conversation.

If one server fails to start, Agav continues without it. Run `/debug` to see connected server names and counts for discovered resources and prompts.

## Live refresh

When a connected server sends `notifications/tools/list_changed`, `notifications/resources/list_changed`, or `notifications/prompts/list_changed`, Agav re-fetches the corresponding catalog from that server and updates the session immediately — no restart needed. This only applies to changes the server advertises at runtime; edits to `config.json` itself still require a restart.

## Related

- [Research GitHub with an MCP Server](/guides/mcp) — practical walkthrough using the GitHub MCP server

