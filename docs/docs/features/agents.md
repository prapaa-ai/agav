---
title: Agents
description: Specialized sub-agents with scoped tools, credentials, and system prompts
order: 5
---

# Agents

Agents are named, purpose-built sub-agents that extend Agav with domain-specific capabilities. Each agent has its own tool set, system prompt, and isolated credentials. When your query involves a task an agent handles — listing GitHub PRs, searching Jira tickets, taking a screenshot — the LLM routes to it automatically.

## How agents work

When Agav starts, it loads all enabled agents and registers each one as a callable tool. The LLM reads a compact catalog (one line per agent, capped at ~500 tokens total) and chooses the right agent for the task.

An agent invocation runs a nested agent loop with the agent's tools, system prompt, and credentials — fully isolated from the parent session. Results stream back to you normally.

## Loading order

Agav discovers agents from three locations. Later tiers override earlier ones by name, so you can replace a bundled agent with a custom version:

| Tier | Location | Override priority |
| --- | --- | --- |
| Bundled | Shipped with Agav binary | Lowest |
| Global | `~/.agav/agents/` | Middle |
| Project | `.agav/agents/` in the working directory | Highest |

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

Selecting **New Agent** launches a four-step wizard:

1. **Name & Description** — pick a unique agent name and a short description of what it does.
2. **System Prompt** — write the agent's system prompt, or press `g` to auto-generate one. The LLM uses your name and description to draft a prompt you can edit before continuing.
3. **MCP Servers** — select which MCP servers the agent should have access to. The list is populated from your workspace config (`mcp-servers` in `.agav/config.json` or `~/.agav/config.json`).
4. **Review & Save** — preview the full agent definition and confirm. The agent is saved to `~/.agav/agents/<name>/` and immediately available for use.

## Templates

When you delete a user-created agent, Agav automatically saves it as a **template** so you can recreate it later without starting from scratch.

- Templates appear in the Create tab's "My Agents" list with a `[template]` label.
- Opening a template pre-populates the wizard with the original name, description, system prompt, and MCP server selections — edit anything before saving.
- Press `d` on a template in the list to remove it permanently.
- Templates are stored in `~/.agav/agents/templates.json`.

## Per-agent MCP servers

Agents can declare MCP servers in their manifest. Each server entry supports an `env` field for passing environment variables (API keys, base URLs, etc.) to the server process.

Servers are started when the agent runs and stopped when it finishes — they are fully scoped to the agent's lifecycle and do not affect the parent session or other agents.

## Credentials

Each agent declares the environment variables it needs (`required-config` in the manifest). Credentials are:

- Stored encrypted in `~/.agav/agents/<name>/config.json` — never in plain text
- Injected into `process.env` only during that agent's execution — not shared with other agents or the parent session
- Editable from the agent inspect view: `/agents → inspect → e`

Agents with missing credentials show a `⚠ Needs config` indicator in the List tab. The LLM receives an error message if it tries to call an unconfigured agent.

## Tool permissions and confirmation

Every tool in an agent is classified as either `safe` (read-only) or `modifies` (creates, edits, or deletes data):

- **Safe tools** run without a confirmation prompt.
- **Modifies tools** pause and display a `[Y]es / [N]o / [A]lways` confirmation before executing.

The classification is declared in the agent manifest (`tool-permissions`) and is visible in the inspect view.

Agent tools also run inside the OS-level sandbox when one is available (Seatbelt on macOS, Bubblewrap on Linux). This applies the same filesystem, network, and credential isolation described in [Security — Shell sandbox](/reference/security#shell-sandbox) to every agent tool execution, not just shell commands. Bundled agent tools are excluded from sandboxing since they ship with Agav.

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

## Related

- [Agent Marketplace](/features/agent-marketplace) — browse and install community agents
- [Agent Manifest reference](/reference/agent-manifest) — full AGENT.md format
- [Build a Native Agent](/guides/build-native-agent) — write your own agent
- [Install and Configure an Agent](/guides/install-and-configure-agent) — step-by-step walkthrough
- [Build an Agent from a Template](/guides/build-agent-from-template) — restore and customize a saved template
