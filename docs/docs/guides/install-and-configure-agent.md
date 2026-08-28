---
title: Install and Configure an Agent
description: Step-by-step guide to installing a marketplace agent and setting up its credentials
guideLevel: beginner
order: 10
---

# Install and Configure an Agent

This guide walks through installing the Jira agent from the marketplace, configuring its credentials, and using it in a session. The same steps apply to any marketplace agent.

## Prerequisites

- Agav installed and connected to an LLM provider
- Credentials for the service you're connecting (e.g. a Jira API token)

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

Press `1` to install globally. Agav copies the agent files and registers it. You'll see `✓ installed (global)` once complete.

## Step 4: Switch to the List tab

Press `1` to open the **List** tab. You should see the jira agent under **Global:** with status `[disabled] ⚠ Needs config`.

## Step 5: Inspect the agent

Navigate to the jira entry and press `i`. The inspect view shows:

- **Required Config** — credentials the agent needs
- **Tools** — individual tool names with `safe` / `modifies` labels
- **Model / Effort** — `inherited from session` (can be overridden)

## Step 6: Open the config editor

Press `e` to open the credential and settings editor. Each required credential appears in the list with its status:

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

For **JIRA_API_TOKEN**: paste your [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) — paste with `Ctrl+V` / `Cmd+V`, then `ENTER`.

After saving each value, the status changes to `✓ configured`.

Press `ESC` to return to the inspect view.

## Step 8: Enable the agent

Press `b` to return to the List tab. Navigate to jira and press `ENTER` to toggle it **enabled**. The status changes to `[enabled] Ready ✓`.

## Step 9: Use the agent

Return to your main chat and ask Agav something Jira-related:

```
what are my open Jira tickets?
```

Agav routes the query to the jira agent. The first time it calls a `modifies` tool (like creating or updating an issue), you'll see a confirmation prompt:

```
jira_create_issue — input: { ... }
[Y]es  [N]o  [A]lways
```

Read-only (`safe`) tools like `jira_search_issues` run without prompting.

## Troubleshooting

**`⚠ Needs config` after entering credentials** — credentials are checked immediately on save. If the indicator persists, press `e` again and verify the values, particularly that there are no leading or trailing spaces.

**Agent not appearing in the list** — press `r` in the marketplace to refresh, or restart Agav if you just installed.

**Credential forgotten** — open the config editor again and re-enter the value. Old values are overwritten.

## Related

- [Agent Marketplace](/features/agent-marketplace) — browsing and installing
- [Agents](/features/agents) — how credentials and permissions work
- [Build a Native Agent](/guides/build-native-agent) — write your own agent
