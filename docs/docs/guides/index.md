---
title: Guides
description: Apply Agav to advanced, multi-step development workflows
order: 1
---

# Guides

Guides are end-to-end recipes for workflows that combine several Agav capabilities. They assume you have completed [Your First Repository Task](/getting-started/quick-start).

For a single command or feature, use [Workflows](/workflows), [Features](/features), or [Reference](/reference) instead. Keeping those explanations in one place prevents the same setup and command details from drifting across multiple pages.

The examples use [quora/model-deprecation-tracker](https://github.com/quora/model-deprecation-tracker), but the patterns apply to other repositories.

## Choose a guide

| When you need to… | Guide |
| --- | --- |
| Reduce elapsed time for independent reads and checks | [Run Tools in Parallel](/guides/parallel-tools) |
| Delegate independent investigations | [Coordinate Parallel Subagents](/guides/parallel-agents) |
| Build and improve a repeatable procedure | [Author and Evolve a Skill](/guides/create-search-skill) |
| Combine reusable policy, direct tools, and delegation | [Compose Agents, Skills, and Tools](/guides/agent-skill-tool-combinations) |
| Repeat work on an interval, file change, or schedule | [Automate with Loops, Watch, and Schedules](/guides/scheduler) |
| Carry durable knowledge across conversations | [Use Memory Across Sessions](/guides/leverage-memory) |
| Connect an external tool or data source | [Connect an MCP Server](/guides/mcp) |
| Add a local JavaScript tool | [Create a Local Plugin](/guides/plugins) |
| Operate a multi-phase task with checkpoints | [Operate a Long-Running Task](/guides/long-running-agent) |

Start with the narrowest guide that matches your task. Add subagents, automation, or extension points only when the work has a clear independent boundary or will be repeated.
