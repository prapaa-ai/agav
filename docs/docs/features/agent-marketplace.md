---
title: Agent Marketplace
description: Browse, install, and manage community agents from the official marketplace
order: 6
---

# Agent Marketplace

The agent marketplace is a catalog of community-built agents hosted on GitHub. Agav reads the catalog at startup (when you open the Marketplace tab) and lets you install agents directly into your global or project configuration.

## Opening the marketplace

```
/agents → [2] Marketplace
```

The marketplace tab fetches `index.json` from the configured marketplace URL and displays all available agents.

## Browsing agents

Agents are displayed three per page. Navigate with:

| Key       | Action                                                             |
| --------- | ------------------------------------------------------------------ |
| `↑` / `↓` | Move selection within the current page                             |
| `←` / `→` | Previous / next page                                               |
| `s`       | Open search — filter by name, description, category, or tag        |
| `i`       | Inspect selected agent (shows tools, credentials, and description) |
| `r`       | Refresh from the marketplace URL                                   |
| `ESC`     | Clear search / exit                                                |

Agents already installed on your system show a `✓ global` or `✓ project` badge.

## Installing an agent

Select an agent and press `ENTER`. If the agent is not yet installed, a destination prompt appears:

```
Install jira:
[1] Global (~/.agav/agents/) — available in all projects
[2] Project (.agav/agents/) — this project only
ESC: Cancel
```

Press `1` or `2` to install. If the agent is already installed at project scope, pressing `ENTER` offers to promote it to global (removes the project copy and reinstalls globally).

Globally installed agents block re-installation at project scope — use the List tab to manage them instead.

## Configuring after install

After installing, switch to the List tab to configure credentials:

```
/agents → [1] List → select the agent → i (inspect) → e (edit config)
```

The config editor shows each required credential with its current status (`✓ configured` or `✗ not set`). Press `ENTER` on a field to edit it, paste your value, and press `ENTER` again to save. Values are encrypted at rest.

## CLI installation

Install without opening the TUI:

```bash
agav agents install <marketplace-url>/agents/jira
agav agents install ./path/to/local-agent --destination project
agav agents install https://github.com/org/repo/tree/main/agents/my-agent
```

## Local marketplace

For local development and testing, clone the marketplace repo and set:

```json
{
  "agentMarketplace": "file:///Users/you/my-marketplace"
}
```

The `AGAV_MARKETPLACE_URL` environment variable overrides the config file value and the built-in default.

## Hosting a marketplace

Any GitHub repository (or static file server) can act as a marketplace. The minimum structure:

```
my-marketplace/
├── index.json          ← required — lists available agents
└── agents/
    └── my-agent/
        ├── AGENT.md    ← required — manifest and system prompt
        └── tools/
            └── *.mjs   ← one file per tool
```

See the [official marketplace repository](https://github.com/prapaa-ai/agav-marketplace) for a complete example.

## Deleting agents

When a user-created agent (one without a marketplace `sourceUrl`) is deleted from the List or Create tab, Agav automatically saves it as a template before removal. The template preserves the agent's name, description, system prompt, MCP server selections, and tags. You can restore it later from the Create tab (`[3] Create`).

Marketplace agents (those installed from a URL) are deleted without creating a template — they can be reinstalled from the marketplace at any time.

## Related

- [Agents](/features/agents) — how agents work
- [Install and Configure an Agent](/guides/install-and-configure-agent) — step-by-step guide
- [Agent Manifest](/reference/agent-manifest) — AGENT.md format reference
