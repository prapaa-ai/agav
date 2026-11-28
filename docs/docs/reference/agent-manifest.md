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
native-tools: [read_file, web_search]
model: claude-sonnet-4-5
effort: medium
tags: [my-api, records]
tool-permissions:
  my_agent_list_records: safe
tools:
  - name: my_agent_list_records
    description: List records
    inputSchema:
      type: object
      properties:
        limit: { type: number, default: 20 }
mcp-servers:
  - key: my-mcp
    command: npx
    args: [-y, "@scope/my-mcp-server"]
    tools: [list_records]
---

# My Agent

System prompt content here.
```

## Front-matter fields

### Core fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | — | Unique identifier. Used as the tool name: `<name>_agent`. For installation, use at most 64 characters: start with a letter or digit; the rest may also include dots, hyphens, or underscores. |
| `description` | string | yes | — | One-line description shown in the agent catalog and marketplace search. Guides the LLM when routing queries. |
| `version` | string | yes | — | Semver version string (e.g. `1.0.0`). |
| `type` | `native` \| `a2a` | no | `native` | Execution model. `native` runs agent-local JavaScript in a subprocess for installed agents; `a2a` delegates to a local HTTP process. |
| `enabled` | boolean | no | `true` | Whether the agent is active at startup. A saved registry entry overrides this field; `agav agents install` registers the agent as enabled. |

### Configuration

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `required-config` | string[] | no | — | Environment variable names the agent needs. The config editor encrypts saved values in `config.json` inside the installed agent directory. Native tools and declared MCP subprocesses receive the saved configuration at runtime. |
| `tools-dir` | string | no | `./tools` | Relative path to the directory containing `.mjs` or `.js` tool files. |
| `tools` | object[] | no | — | Tool schemas exposed to the model: `name`, `description`, `inputSchema`, and optional `destructive`. See [Tool file format](#tool-file-format). |
| `native-tools` | string[] | no | none | Explicit allowlist of built-in Agav tools available to a **native** agent. Each value is a built-in tool schema name, such as `read_file` or `web_search`. When omitted or empty, no built-in Agav tools are added; the agent can still use its agent-local tools and declared MCP tools. |

### Model and effort

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `model` | string | no | inherit session | LLM model override for this agent. Shown as `<model> (agent override)` in the inspect view; clear the value in the config editor to revert to inheriting. |
| `effort` | `minimal` \| `low` \| `medium` \| `high` \| `max` | no | inherit session | Reasoning effort override for this agent. |

### Discovery

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tags` | string[] | no | — | Keywords shown in the marketplace and used for search filtering. |
| `author` | string | no | — | Attribution displayed in the inspect view. |

### Tool permissions

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tool-permissions` | Record\<string, `safe` \| `destructive`\> | no | — | Overrides the `destructive` flag on the discovered schema. Keys must match the exposed tool names. Marking an external tool `safe` does not bypass [confirmation](/reference/security#external-tool-trust). |

### Per-agent MCP servers

```yaml
mcp-servers:
  - key: my-mcp
    command: npx
    args: [-y, "@scope/my-mcp-server"]
    env:
      LOG_LEVEL: warn
    tools: [list_records]
```

Only stdio servers are supported here. They start for the native agent invocation and stop when it finishes. Their tools are not added to the parent session. The server environment starts with Agav’s launch environment, then applies literal `env` values, then the agent’s saved configuration (which wins on conflicts). There is no `${VAR}` interpolation. `tools` is an optional list of unprefixed server tool names, with the same selection and fallback rules as [workspace MCP servers](/features/mcp#limiting-which-tools-are-exposed).

### A2A fields (experimental)

Used when `type: a2a`. See [Build a Native Agent — A2A section](/guides/build-native-agent#a2a-agents--experimental) for the protocol specification.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `start-command` | string | yes (A2A) | Executable and arguments, run directly without a shell from the agent directory. |
| `endpoint` | string | yes (A2A) | Loopback HTTP base URL (e.g. `http://127.0.0.1:4000`). Remote hosts are unsupported. |

## Tool file format

Each tool file exports an `execute(input)` function, usually on a default-exported object. For example, save this as `tools/my-agent-list-records.mjs`:

```js
export default {
  async execute(input) {
    const { MY_API_KEY } = process.env;  // credentials injected by Agav
    // ...
    return { output: "Result text", isError: false };
  }
};
```

For installed agents, declare each schema in the manifest’s `tools` list or in a sibling `<basename>.schema.json` file. Agav prefers the manifest, then the sidecar, then a generic `{ task: string }` schema. It does not import the JavaScript to discover the schema. Use a matching basename, converting hyphens to underscores for manifest lookup (for example, `list-records.mjs` → `list_records`).

## System prompt body

The Markdown content after the `---` closing delimiter becomes the agent's system prompt. It is appended to the configured base system prompt, if there is one. Keep it focused:

- One role sentence: "You are a \<service\> assistant..."
- 3–5 guideline bullets covering precision, confirmation for modifying tools, output formatting, and error handling
- Avoid restating tool schemas — that information is already in the tool definitions

## Related

- [Agents](/features/agents) — loading, routing, and credentials
- [Build a Native Agent](/guides/build-native-agent) — full walkthrough with examples
- [Agent Marketplace](/features/agent-marketplace) — installing from the catalog
