---
title: Install and Configure an Agent
description: Step-by-step guide to installing a marketplace agent and setting up its credentials
guideLevel: beginner
order: 10
---

# Install and Configure an Agent

This guide walks through installing the Jira agent from the marketplace, configuring its credentials, and using it in a session. Use the same flow for other marketplace agents, but check their required credentials, tools, and permissions before installing.

## Prerequisites

- Agav installed and connected to an LLM provider
- Credentials for the service you're connecting (e.g. a Jira API token)
- A trusted agent source. The Windows shell sandbox does not cover marketplace agent JavaScript; on macOS/Linux, Agav's separate agent sandbox can block outbound network access. Read the [agent sandbox notes](/features/agents#agent-sandbox) before using a network-dependent agent.

## Step 1: Open the marketplace

Start Agav and type:

```
/agents
```

Press `2` to switch to the **Marketplace** tab. Agav fetches the catalog. You'll see agents listed three per page with name, description, tool count, and category.

## Step 2: Find and inspect the agent

Use `↑` / `↓` to navigate and `←` / `→` to page through results. Press `s` to search by name or keyword.

Navigate to **jira** and press `i` to inspect it. The inspect view shows the full description, tool list (with `safe` and `modifies` labels), and required credentials.

Press `b` or `ESC` to go back.

## Step 3: Install

With the agent selected, press `ENTER`. A destination prompt appears:

```
Install jira:
[1] Global (~/.agav/agents/) — available in all projects
[2] Project (.agav/agents/) — this project only
```

Press `1` to install globally. Agav copies the agent files and registers it. You'll see `✓ installed (global)` once complete. On Windows, the global location `~/.agav/agents/` resolves to `%USERPROFILE%\.agav\agents\`.

## Step 4: Switch to the List tab

Installation returns you to the **List** tab. If you switched away, press `1` to return. Find the `jira` entry with origin `global`. New installs are enabled by default, but the agent still needs its required credentials.

## Step 5: Inspect the agent

Highlight the `jira` entry and press `v` for **Agent diagnostics**. The diagnostics view shows:

- **Required Config** — credentials the agent needs
- **Tools** — individual tool names with `safe` / `modifies` labels
- **Model / Effort** — `inherited from session` (can be overridden)

## Step 6: Open the config editor

Press `e` from diagnostics, or `c` from the List tab, to open the credential and settings editor. Each required credential appears in the list with its status:

```
→ JIRA_URL         ✗ not set
  JIRA_EMAIL       ✗ not set
  JIRA_API_TOKEN   ✗ not set
  Model            inherited from session
  Effort           inherited from session
```

Navigate with `↑` / `↓` and press `ENTER` on a field to edit it.

## Step 7: Enter credentials

For **JIRA_URL**: type or paste your Jira base URL (e.g. `https://your-org.atlassian.net`), then press `ENTER`.

For **JIRA_EMAIL**: enter your Atlassian account email, then `ENTER`.

For **JIRA_API_TOKEN**: paste your [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) using your terminal's paste shortcut, then press `ENTER`.

The editor saves each value in the agent's own encrypted `config.json` (for this install, `~/.agav/agents/jira/config.json`, or `$HOME\.agav\agents\jira\config.json` in PowerShell). Do not commit the credential file if you install into a project.

Press `ESC` to return to the inspect view.

## Step 8: Check readiness

In diagnostics, check that all required values are configured. If the agent was disabled, return to the List tab with `b`, highlight `jira`, and press `t` to enable it. `ENTER` opens details; it does not toggle the agent.

## Step 9: Use the agent

Return to your main chat and ask Agav something Jira-related:

```
what are my open Jira tickets?
```

If Agav does not delegate, ask it to use the Jira agent explicitly. In `ask` mode, agent tools can require approval even when the catalog marks them `safe`. In `deny-writes` mode, third-party tools are blocked. Review any request before approving it. A ready status only means the required settings are present; it does not validate your service credentials or prove the tool can reach Jira.

## Troubleshooting

**`⚠ Needs config` after entering credentials** — credentials are checked immediately on save. If the indicator persists, press `e` again and verify the values, particularly that there are no leading or trailing spaces.

**Agent not appearing in the list** — press `r` in the List tab to reload installed agents. If Jira is missing from the marketplace, press `r` there and check which marketplace catalog is configured.

**Replace a credential** — open the config editor again, select the field, press `Delete` to clear the existing value, and save the replacement with `ENTER`.

## Related

- [Agent Marketplace](/features/agent-marketplace) — browsing and installing
- [Agents](/features/agents) — how credentials and permissions work
- [Build a Native Agent](/guides/build-native-agent) — write your own agent
