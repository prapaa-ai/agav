---
title: Features
description: Explore Agav tools, skills, MCP integrations, plugins, and subagents
order: 1
---

# Features

Agav combines a core toolset with extension points that add reusable knowledge and external capabilities.

- [Built-in tools](/features/built-in-tools) cover files, search, shell, background processes, testing, language servers, notebooks, GitHub, web access, plans, and memory.
- [Background processes](/features/background-processes) start daemon-backed shell commands, keep logs under `~/.agav/background-processes/`, and reattach with completion notifications after restart.
- [Skills](/features/skills) package reusable instructions and tool policies, with a built-in marketplace, validation, and automatic improvement.
- [MCP](/features/mcp) connects stdio subprocess servers and remote HTTP/SSE endpoints that expose tools, resources, and prompts.
- [Plugins and subagents](/features/plugins-and-subagents) add JavaScript tools and parallel task execution.
- [Agents](/features/agents) are specialized sub-agents with scoped tools, credentials, and system prompts.
- [Agent Marketplace](/features/agent-marketplace) provides community-built agents for cloud platforms, developer workflows, and automation.

Tools are chosen by the model based on the task. Read-only operations can run directly; sensitive operations follow the active permission mode and may require confirmation.
