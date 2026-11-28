---
title: Agents
description: Specialized sub-agents with scoped tools, credentials, and system prompts
order: 5
---

# Agents

Agents are named, purpose-built sub-agents that extend Agav with domain-specific capabilities. Each agent has its own tool set, system prompt, and isolated credentials. When your query involves a task an agent handles — listing GitHub PRs, searching Jira tickets, taking a screenshot — the LLM routes to it automatically.

## How agents work

When Agav starts, it loads all enabled agents and registers each one as a callable tool. The LLM reads a compact catalog (one line per agent, capped at ~500 tokens total) and chooses the right agent for the task.

An agent invocation runs a nested agent loop with the agent's tools, system prompt, and credentials, with a separate conversation and tool registry. Results stream back to you normally.

## Loading order

Agav discovers agents from three locations. Later tiers override earlier ones by name, so you can replace a bundled agent with a custom version:

| Tier | Location | Override priority |
| --- | --- | --- |
| Bundled | Shipped with Agav binary (currently empty — reserved for future built-in agents) | Lowest |
| Global | `~/.agav/agents/` | Middle |
| Project | `.agav/agents/` in the working directory | Highest |

> **Windows:** `~/.agav/` paths resolve to `%USERPROFILE%\.agav\`.

## Installing agents from the marketplace

Browse and install agents from the community marketplace:

```
/agents → [2] Marketplace
```

See [Agent Marketplace](/features/agent-marketplace) for full details.

## Creating agents

You can create custom agents directly from the TUI without writing a manifest by hand:

```
/agents → [3] Create
```

The **Create** tab opens a "My Agents" hub that lists your user-created agents and any saved templates. From here you can create a new agent or restore one from a template.

### Wizard flow

Selecting **New Agent** launches a five-step wizard:

1. **Name & Description** — pick a unique agent name and a short description of what it does.
2. **System Prompt** — write the agent's system prompt, or press `g` to auto-generate one. The LLM uses your name and description to draft a prompt you can edit before continuing.
3. **Native Tools** — select the built-in Agav tools the agent can use. This creates the manifest's `native-tools` allowlist; leave every option unchecked if the agent should use only its local and MCP tools.
4. **MCP Servers** — select which MCP servers the agent should have access to. The list is populated from your workspace config (`mcpServers` in `.agav/config.json` or `~/.agav/config.json`).
5. **Review & Save** — preview the full agent definition and confirm. The agent is saved to `~/.agav/agents/<name>/` and immediately available for use.

## Templates

When you delete a user-created agent, Agav automatically saves it as a **template** so you can recreate it later without starting from scratch.

- Templates appear in the Create tab's "My Agents" list with a `[template]` label.
- Opening a template pre-populates the wizard with the original name, description, system prompt, and MCP server selections — edit anything before saving.
- Press `d` on a template in the list to remove it permanently.
- Templates are stored in `~/.agav/agents/templates.json`.

## Per-agent MCP servers

Native agents can declare **stdio** MCP servers in their manifest. The `/agents` wizard can copy command-based servers from workspace configuration. It does not import URL-only HTTP/SSE entries, and subsequent edits preserve the agent’s saved server settings rather than resyncing them. See [per-agent MCP fields](/reference/agent-manifest#per-agent-mcp-servers) for environment precedence and tool selection.

Servers are started when the agent runs and stopped when it finishes — their tools are scoped to that invocation. The server process itself is not sandboxed by the agent-tool runner.

## Credentials

Each agent declares the environment variables it needs (`required-config` in the manifest). Credentials are:

- Saved encrypted by the config editor in `config.json` inside the installed agent directory. Don’t commit a project agent’s `config.json`.
- Passed to native tools at runtime and to any stdio MCP servers declared by that agent. MCP subprocesses also inherit Agav’s launch environment.
- Editable from the agent inspect view: `/agents → inspect → e`

Agents with missing credentials show a `⚠ Needs config` indicator in the List tab. The LLM receives an error message if it tries to call an unconfigured agent.

## Tool permissions and confirmation

The manifest can classify tools as `safe` or `destructive`. In `ask` mode, marking an agent-local or MCP tool `safe` does **not** exempt it from confirmation. Trusted built-ins retain their normal permission rules. `deny-writes` refuses tool calls that still require confirmation. See [Security](/reference/security#external-tool-trust).

## Native tool access

Native agents do not automatically receive Agav's built-in tools. Select the tools they need during creation, or open `/agents → List → inspect → e` and edit **Native Tools**. The chosen tools are written to the agent's `native-tools` manifest allowlist. Leaving the list empty keeps built-in tools unavailable while preserving agent-local and declared MCP tools. Bundled and A2A agents cannot edit this setting.

### Agent sandbox

Non-bundled agent-local JavaScript runs in a subprocess. On macOS with Seatbelt or Linux with Bubblewrap, it uses a separate profile that blocks networking. On Windows, or when neither supported agent backend is available, it runs without OS sandboxing. The Windows restricted-token and Docker shell backends do not cover these tools, and `sandboxRequired` does not make them fail closed. Built-ins such as `run_command` keep their own policy; per-agent MCP and A2A processes do not use the agent-tool profile. Install only code you trust.

## Model and effort overrides

Agents inherit the session's model and effort by default. You can override them per-agent in the config editor (`/agents → inspect → e`). The override is stored in the agent's `config.json` and shown as `<model> (agent override)` in the inspect view. Clear the value to revert to inheriting from the session.

## CLI

```bash
agav agents list                       # List all agents by origin
agav agents install <url|path>         # Install from URL or local directory
agav agents install <url> --destination project  # Install project-local
agav agents enable <name>              # Enable a disabled agent
agav agents disable <name>             # Disable without uninstalling
agav agents remove <name>              # Remove from disk
```

## TUI

Open `/agents` to manage agents interactively. The three tabs are:

- **`[1] List`** — view, inspect, enable/disable, and remove installed agents.
- **`[2] Marketplace`** — browse and install community agents.
- **`[3] Create`** — create new agents with the wizard, and manage your agents and templates.

The tabs and visible list rows can be selected with a left-click. In list and marketplace views, the mouse wheel moves the selection; resource-manager footer controls such as search, inspect, and refresh are clickable when enabled. Keyboard shortcuts remain available as a fallback, and clicks do not bypass confirmation prompts.

## Related

- [Agent Marketplace](/features/agent-marketplace) — browse and install community agents
- [Agent Manifest reference](/reference/agent-manifest) — full AGENT.md format
- [Build a Native Agent](/guides/build-native-agent) — write your own agent
- [Install and Configure an Agent](/guides/install-and-configure-agent) — step-by-step walkthrough
- [Build an Agent from a Template](/guides/build-agent-from-template) — restore and customize a saved template
