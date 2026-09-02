---
title: Create an Agent with the Wizard
description: Use the built-in wizard to create a custom agent with LLM-generated system prompts and workspace MCP servers
guideLevel: beginner
order: 12
---

# Create an Agent with the Wizard

The agent creation wizard lets you build a custom agent in four guided steps — name it, generate a system prompt with your LLM, attach MCP servers, and save. Agav writes the `AGENT.md` manifest for you and registers the agent immediately.

This guide walks through creating a `github-helper` agent from scratch, then covers editing existing agents and working with templates.

## Prerequisites

- Agav installed and connected to an LLM provider (needed for automatic system prompt generation)

## Step 1: Open the Create tab

Start Agav and type:

```
/agents
```

Press `3` to switch to the **Create** tab. This is the "My Agents" hub — it shows your user-created agents, saved templates, and a `[+ New Agent]` button at the top.

If you haven't created any agents yet, the list will be empty except for the `[+ New Agent]` entry.

## Step 2: Start the wizard

Navigate to `[+ New Agent]` and press `ENTER` to launch the four-step creation wizard. A progress bar at the top tracks your position through the flow:

```
Name & Description → System Prompt → MCP Servers → Review & Save
```

You can press `b` or `ESC` at any step to go back to the previous one without losing your input.

## Step 3: Name and describe the agent

The first step asks for two fields: **Name** and **Description**.

**Name** — type a short, unique identifier for your agent. Names must be lowercase alphanumeric characters, hyphens, dots, or underscores, with a maximum length of 64 characters. For example:

```
github-helper
```

Press `TAB` or `↓` to move to the **Description** field.

**Description** — write a one-line summary of what the agent does. This appears in the agent list and helps the LLM understand when to route queries to this agent:

```
Helps with GitHub repository management tasks
```

Press `ENTER` to advance to the next step.

## Step 4: Review the system prompt

Agav sends your name and description to your configured LLM provider and auto-generates a system prompt tailored to the agent's purpose. The prompt streams in real-time inside a bordered preview box.

Once generation completes, review the prompt. It typically includes:

- A role definition ("You are a GitHub assistant…")
- Guidelines for tool usage
- Response formatting instructions

If the prompt doesn't match what you need, press `r` to regenerate it. You can regenerate as many times as you like — each attempt produces a fresh prompt based on your name and description.

When you're satisfied, press `ENTER` to accept the prompt and continue.

## Step 5: Select MCP servers (optional)

This step shows a list of MCP servers defined in your workspace `config.json`. Each server appears with a checkbox.

- Press `↑` / `↓` to navigate the list
- Press `SPACE` to toggle a server on or off

Selected servers are bundled into the agent's manifest, making them available whenever the agent runs. This is useful for agents that need access to specific tools — for example, a `github-helper` agent might use a GitHub MCP server for repository operations.

If you don't need any MCP servers, or none are configured in your workspace, press `ENTER` to skip this step and continue.

## Step 6: Review and save

The final step shows a summary of everything you've configured:

- **Name** — `github-helper`
- **Description** — "Helps with GitHub repository management tasks"
- **Destination path** — where `AGENT.md` will be written
- **System prompt preview** — the generated prompt text
- **MCP servers** — any servers you selected
- **Tags** — auto-generated from your name and description

Review the summary. If anything looks wrong, press `b` to go back and make changes.

Press `ENTER` to create the agent. Agav:

1. Writes the `AGENT.md` manifest to disk
2. Registers the agent in the agent registry
3. Validates the manifest
4. Reloads the agent list

You'll see a confirmation message once the agent is ready. It appears immediately in both the **List** and **Create** tabs.

## Editing an existing agent

To modify a user-created agent, open the **Create** tab, navigate to it in the list, and press `ENTER`. The wizard opens with all fields pre-populated from the existing manifest.

During edits:

- **Name** is read-only — you cannot rename an agent after creation
- **Description** can be updated freely
- **System prompt** can be regenerated with `r` or accepted as-is
- **MCP servers** can be added or removed

The same four-step flow applies. Press `ENTER` on the final review step to save your changes.

## Working with templates

Templates preserve deleted agents so you can restore them later.

**How templates are created** — when you delete a user-created agent (from either the **List** or **Create** tab), Agav automatically saves it as a template. Nothing extra is required.

**Finding templates** — templates appear in the **Create** tab alongside your active agents, marked with a `[template]` label.

**Restoring a template** — navigate to a template and press `ENTER`. The wizard opens with all fields pre-populated (name, description, system prompt, and MCP servers). Walk through the steps and press `ENTER` on the review step to recreate the agent.

**Deleting a template permanently** — navigate to a template and press `d`. This removes it from the template store with no way to recover it.

**Storage** — templates are stored in `~/.agav/agents/templates.json`. This file is managed automatically; you don't need to edit it by hand.

## Keyboard reference

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate list or switch wizard fields |
| `TAB` | Switch between name and description fields |
| `ENTER` | Select / advance / save |
| `SPACE` | Toggle MCP server selection (step 5) |
| `r` | Regenerate system prompt (step 4) |
| `b` / `ESC` | Go back one step or exit wizard |
| `d` | Delete agent or template from list |

## Related

- [Agents](/features/agents) — how agents work
- [Build a Native Agent](/guides/build-native-agent) — manual agent creation with custom tools
- [Agent Manifest](/reference/agent-manifest) — `AGENT.md` format reference
- [Install and Configure an Agent](/guides/install-and-configure-agent) — marketplace agents
