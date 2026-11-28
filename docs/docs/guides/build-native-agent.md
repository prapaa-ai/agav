---
title: Build a Native Agent
description: Write a custom agent with domain-specific tools, credentials, and a system prompt
guideLevel: advanced
order: 11
---

# Build a Native Agent

A native agent combines an `AGENT.md` manifest with tools. This example builds a self-contained tool that needs no network access, dependencies, or credentials. The setup commands work from macOS, Linux, and Windows terminals.

## 1. Create the manifest

Create `my-agent/AGENT.md`:

```markdown
---
name: my-agent
description: Format a short greeting for a named person
version: 1.0.0
type: native
tools-dir: ./tools
tool-permissions:
  greet_user: safe
tools:
  - name: greet_user
    description: Format a greeting for a named person
    inputSchema:
      type: object
      properties:
        name:
          type: string
      required: [name]
---

Use greet_user to return a greeting for the requested name.
```

The manifest’s `tools` entry lets Agav discover the schema without importing your code. The `safe` label describes the tool but does not exempt it from confirmation in `ask` mode. Use `destructive` for tools that change state. See the [Agent Manifest reference](/reference/agent-manifest) for credential fields, schema sidecars, and built-in tool access.

## 2. Write the tool

Create `my-agent/tools/greet-user.mjs`:

```js
export default {
  async execute({ name }) {
    return { output: `Hello, ${name}!`, isError: false };
  }
};
```

Use `.mjs` for ES module syntax on every platform. The filename `greet-user.mjs` matches the manifest name `greet_user`. Return `{ output: string, isError: boolean }` and reserve stdout for Agav’s tool result protocol.

## 3. Install and test

Run from the directory containing `my-agent`:

```sh
agav agents install ./my-agent
agav agents list
```

Add `--destination project` to install only for the current project, or `--alias my-agent-v2` to install under another name. CLI installation registers the agent as enabled. Start or restart Agav and ask: “Use `my-agent` to greet Ada.” In `ask` mode, review the agent and tool calls before approving them. For an agent that needs credentials, open `/agents → List → inspect (i) → edit config (e)`.

**Platform limits:** Installed JavaScript tools use separate Seatbelt or Bubblewrap profiles when available on macOS or Linux. Both profiles block network access, so an agent-local tool that calls an external API with `fetch()` will not work there. The Windows restricted-token shell sandbox does not cover native-agent JavaScript. See [Agent sandbox](/features/agents#agent-sandbox) before installing or distributing code.

## Using the LLM to implement tools

In the List tab, inspect a global agent with `i`, then press `f` when **Implement tools** appears. To make a stub eligible, put `TODO` in its exposed schema description and in the tool source. A configured provider is required. Review the generated implementation before running it.

## Sharing via the marketplace

Add the agent directory and an `index.json` entry to the [Agav marketplace repository](https://github.com/prapaa-ai/agav-marketplace). Include the `files` list for HTTP installation. See [Agent Marketplace](/features/agent-marketplace#hosting-a-marketplace).

## A2A Agents — Experimental

An A2A agent runs a separate executable and communicates over loopback HTTP. This integration is experimental and is not the same as the [remote MCP transport](/features/mcp#remote-servers-http--sse).

### Manifest

```markdown
---
name: my-python-agent
type: a2a
start-command: python3 agent.py --port 4000
endpoint: http://127.0.0.1:4000
description: Python-based agent for data processing
version: 1.0.0
---
```

Use the interpreter executable available on your machine (for example, `python.exe` on Windows). Agav runs the command directly from the installed agent directory, not through a shell. Shell pipelines, variable expansion, and Windows `.cmd` wrappers are not supported. The subprocess inherits Agav’s launch environment and is not covered by the shell sandbox. Review the executable and its arguments before invoking it.

### Protocol

| Endpoint | Method | Behavior |
| --- | --- | --- |
| `/health` | GET | Return a successful HTTP response when ready. |
| `/execute` | POST | Accept `{task, context?}` and return `{output: string, isError: boolean}` as JSON. |

Use a loopback endpoint; remote hosts are unsupported. Agav polls health with a ten-second startup budget, then sends tasks to `/execute`. Normal agent invocation does not use the experimental `/stream` client. Per-agent credential injection, per-agent MCP servers, and confirmations for individual actions inside the A2A process are not supported.

## Related

- [Agent Manifest reference](/reference/agent-manifest) — all AGENT.md fields
- [Install and Configure an Agent](/guides/install-and-configure-agent) — end-user walkthrough
- [Agents](/features/agents) — how agents are loaded and routed
