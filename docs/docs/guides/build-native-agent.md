---
title: Build a Native Agent
description: Write a custom agent with domain-specific tools, credentials, and a system prompt
guideLevel: advanced
order: 11
---

# Build a Native Agent

A native agent is a directory containing an `AGENT.md` manifest and one or more `.mjs` tool files. Agav loads these at startup from three locations (bundled, global, project) and registers them as callable sub-agents.

## File structure

```
my-agent/
├── AGENT.md        ← manifest (YAML front-matter) + system prompt
└── tools/
    ├── list-items.mjs
    └── create-item.mjs
```

## AGENT.md

The manifest uses YAML front-matter followed by the agent's system prompt:

```markdown
---
name: my-api
description: Interact with My API — read records, create entries, and search
version: 1.0.0
type: native
required-config:
  - MY_API_KEY
  - MY_API_BASE_URL
tools-dir: ./tools
tags: [my-api, records]
tool-permissions:
  my_api_list_records: safe
  my_api_create_entry: modifies
  my_api_delete_entry: modifies
enabled: false
---

# My API Agent

You are a My API assistant. Use the available tools to read and manage records.

Guidelines:
- Use exact record IDs returned by the list tool
- Confirm before creating or deleting entries
- Format record IDs as `REC-123` in your responses
```

Key front-matter fields:

| Field | Notes |
| --- | --- |
| `name` | Must be unique across all loaded agents. Used as the tool name: `my_api_agent`. |
| `required-config` | List of env var names. Agav will prompt for these in the config editor and encrypt them. |
| `tool-permissions` | Map of tool name → `safe` or `modifies`. `modifies` tools require confirmation before running. |
| `enabled` | Set to `false` to ship disabled by default (users opt in). |
| `model` / `effort` | Optional per-agent overrides; omit to inherit from the session. |

See [Agent Manifest reference](/reference/agent-manifest) for all fields.

## Writing a tool

Each `.mjs` file exports a single default object with `schema` and `execute`:

```js
// tools/list-records.mjs
export default {
  schema: {
    name: "my_api_list_records",
    description: "List records from My API, optionally filtered by status",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status: open, closed, or all",
          default: "open"
        },
        limit: {
          type: "number",
          description: "Maximum results to return",
          default: 20
        }
      }
    }
  },
  async execute(input) {
    const { MY_API_KEY, MY_API_BASE_URL } = process.env;
    if (!MY_API_KEY || !MY_API_BASE_URL) {
      return { output: "Error: Missing MY_API_KEY or MY_API_BASE_URL", isError: true };
    }

    const status = input.status || "open";
    const limit = input.limit || 20;

    try {
      const res = await fetch(`${MY_API_BASE_URL}/records?status=${status}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${MY_API_KEY}` }
      });
      if (!res.ok) {
        return { output: `API error ${res.status}: ${res.statusText}`, isError: true };
      }
      const { records } = await res.json();
      const lines = records.map(r => `• REC-${r.id}: ${r.title} [${r.status}]`);
      return { output: lines.join("\n") || "No records found.", isError: false };
    } catch (err) {
      return { output: `Error: ${err.message}`, isError: true };
    }
  }
};
```

**Rules:**
- `schema.name` must match the key used in `tool-permissions` in AGENT.md.
- `schema.destructive: true` corresponds to `modifies` in AGENT.md permissions. Set it on tools that write, edit, or delete data.
- Credentials come from `process.env` — Agav injects them at runtime, scoped to the agent.
- Return `{ output: string, isError: boolean }` — always a plain string, formatted for human reading.
- Use only `fetch()` and Node.js built-ins (`node:fs`, `node:path`, etc.). No npm packages.

## Installing locally

```bash
# Install globally (available in all sessions)
agav agents install ./my-agent

# Install for the current project only
agav agents install ./my-agent --destination project

# Give it a different name if there's a conflict
agav agents install ./my-agent --alias my-api-v2
```

After installing, open `/agents → List` and press `e` on the agent to enter credentials.

## Using the LLM to implement tools

If you create stub tools with `TODO` in their descriptions, Agav can implement them for you. In the List tab:

1. Select the agent and press `i` to inspect
2. Press `f` — "Implement tools"
3. Agav sends each stub to the LLM with the agent's context and writes back a full implementation

This works for global agents whose tools contain `TODO` in their description. Bundled and marketplace agents are excluded.

## Testing

Enable the agent and ask Agav a relevant question:

```
/agents → List → select my-api → ENTER (toggle enabled)
```

Then in the main chat:

```
list my open records
```

The LLM routes the query to `my_api_agent` and invokes `my_api_list_records`. The first call to any `modifies` tool will show a confirmation prompt.

## Sharing via the marketplace

To publish your agent to the community marketplace:

1. Fork or contribute to the [agav marketplace repository](https://github.com/agav-hq/marketplace)
2. Add your agent directory under `agents/<your-agent>/`
3. Add an entry to `index.json`

---

## A2A Agents — Experimental

> **Note:** A2A (Agent-to-Agent) support is implemented but not production-tested. Use for experimentation only.

An A2A agent runs as an external process (any language) and communicates over HTTP. Agav manages the process lifecycle and proxies calls to it.

### Manifest

```markdown
---
name: my-python-agent
type: a2a
start-command: python agent.py --port 4000
endpoint: http://localhost:4000
description: Python-based agent for data processing
version: 1.0.0
---
```

### Protocol

The external process must implement three endpoints:

| Endpoint | Method | Behaviour |
| --- | --- | --- |
| `/health` | GET | Return HTTP 200 when ready |
| `/execute` | POST | Accept `{task, context?}`, return `{output}` |
| `/stream` | POST | Accept `{task, context?}`, respond with SSE events: `text`, `tool_call`, `tool_result`, `error`, `done` |

Agav polls `/health` for up to 10 seconds on startup before routing the first request.

**Limitations compared to native agents:** A2A agents do not currently support credential injection, HITL confirmation propagation, or per-agent MCP servers. These features are available for native agents only.

## Related

- [Agent Manifest reference](/reference/agent-manifest) — all AGENT.md fields
- [Install and Configure an Agent](/guides/install-and-configure-agent) — end-user walkthrough
- [Agents](/features/agents) — how agents are loaded and routed
