---
title: Agent Manifest (AGENT.md)
description: Complete reference for the AGENT.md format used to define native and A2A agents
order: 4
---

# Agent Manifest (AGENT.md)

Every agent is defined by an `AGENT.md` file: a YAML front-matter block followed by the system prompt in Markdown. Agav parses the front-matter at load time and passes the Markdown body as the agent's system prompt.

## Structure

```markdown
---
name: my-agent
description: Short description shown in the catalog and marketplace
version: 1.0.0
type: native
enabled: false
required-config:
  - MY_API_KEY
  - MY_API_BASE_URL
tools-dir: ./tools
model: claude-sonnet-4-5
effort: medium
tags: [my-api, records]
tool-permissions:
  my_agent_list: safe
  my_agent_create: modifies
  my_agent_delete: modifies
mcp-servers:
  - key: my-mcp
    command: npx
    args: [-y, "@scope/my-mcp-server"]
---

# My Agent

System prompt content here.
```

## Front-matter fields

### Core fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | — | Unique identifier. Used as the tool name: `<name>_agent`. Must be lowercase with hyphens only. |
| `description` | string | yes | — | One-line description shown in the agent catalog and marketplace search. Guides the LLM when routing queries. |
| `version` | string | yes | — | Semver version string (e.g. `1.0.0`). |
| `type` | `native` \| `a2a` | no | `native` | Execution model. `native` runs JS tools in-process; `a2a` delegates to an external HTTP process. |
| `enabled` | boolean | no | `true` | Whether the agent is active at startup. Bundled agents ship with `enabled: false` — users opt in after configuring credentials. |

### Configuration

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `required-config` | string[] | no | — | Environment variable names the agent needs. Agav collects these in the config editor and stores them encrypted in `~/.agav/agents/<name>/config.json`. Injected into `process.env` during the agent's execution only. |
| `tools-dir` | string | no | `./tools` | Relative path to the directory containing `.mjs` tool files. |

### Model and effort

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | string | no | inherit session | LLM model override for this agent. Shown as `<model> (agent override)` in the inspect view; clear the value in the config editor to revert to inheriting. |
| `effort` | `low` \| `medium` \| `high` \| `max` | no | inherit session | Reasoning effort override for this agent. |

### Discovery

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tags` | string[] | no | — | Keywords shown in the marketplace and used for search filtering. |
| `author` | string | no | — | Attribution displayed in the inspect view. |

### Tool permissions

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tool-permissions` | Record\<string, `safe` \| `modifies`\> | no | — | Per-tool HITL classification. `safe` runs without confirmation. `modifies` pauses and shows `[Y]es / [N]o / [A]lways` before executing. Keys must match the `schema.name` values in the `.mjs` tool files. |

### Per-agent MCP servers

```yaml
mcp-servers:
  - key: my-mcp          # identifier for this connection
    command: npx          # runtime: npx, uvx, docker, or http
    args: [-y, "@scope/pkg"]  # arguments passed to the runtime
```

MCP servers declared here are started when the agent runs and stopped when it finishes. They are scoped to the agent — other agents and the parent session cannot access them. Credentials from `required-config` are injected into the MCP server process as environment variables.

### A2A fields (experimental)

Used when `type: a2a`. See [Build a Native Agent — A2A section](/guides/build-native-agent#a2a-agents--experimental) for the protocol specification.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `start-command` | string | yes (A2A) | Shell command to launch the external process. |
| `endpoint` | string | yes (A2A) | HTTP base URL of the running process (e.g. `http://localhost:4000`). |

## Tool file format

Each `.mjs` file in `tools-dir` exports a default object:

```js
export default {
  schema: {
    name: "my_agent_list_records",   // must match tool-permissions key
    description: "List records",
    destructive: false,              // false = safe, true = modifies
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results", default: 20 }
      }
    }
  },
  async execute(input) {
    const { MY_API_KEY } = process.env;  // credentials injected by Agav
    // ...
    return { output: "Result text", isError: false };
  }
};
```

`schema.destructive` must match the `tool-permissions` classification: `destructive: false` → `safe`, `destructive: true` → `modifies`.

## System prompt body

The Markdown content after the `---` closing delimiter becomes the agent's system prompt. It is prepended to the base Agav system prompt at runtime. Keep it focused:

- One role sentence: "You are a \<service\> assistant..."
- 3–5 guideline bullets covering precision, confirmation for modifying tools, output formatting, and error handling
- Avoid restating tool schemas — that information is already in the tool definitions

## Related

- [Agents](/features/agents) — loading, routing, and credentials
- [Build a Native Agent](/guides/build-native-agent) — full walkthrough with examples
- [Agent Marketplace](/features/agent-marketplace) — installing from the catalog
