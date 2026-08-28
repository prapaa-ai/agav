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

Open `/agents` to manage agents interactively. Press `1` for the List tab and `2` for the Marketplace tab.

## Related

- [Agent Marketplace](/features/agent-marketplace) — browse and install community agents
- [Agent Manifest reference](/reference/agent-manifest) — full AGENT.md format
- [Build a Native Agent](/guides/build-native-agent) — write your own agent
- [Install and Configure an Agent](/guides/install-and-configure-agent) — step-by-step walkthrough
