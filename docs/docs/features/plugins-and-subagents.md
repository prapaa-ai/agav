---
title: Plugins and Subagents
description: Add local JavaScript tools and delegate parallel work
order: 5
---

# Plugins and Subagents

## Local plugins

Agav loads `.js` and `.mjs` files from `~/.agav/plugins`. A module can default-export one tool or export a `tools` array.

```javascript
export default {
  schema: {
    name: "project_status",
    description: "Return the current project status",
    inputSchema: { type: "object", properties: {} }
  },
  async execute() {
    return { output: "Ready", isError: false }
  }
}
```

Each tool needs `schema.name`, `schema.description`, `schema.inputSchema`, and an async `execute` function returning `{ output, isError }`. Broken plugin modules are skipped. Plugins execute local JavaScript with the same operating-system access as Agav, so install only code you trust and restart Agav after changes.

## Parallel subagents

The `subagent` tool delegates a clear, self-contained task with a short UI title. Subagents:

- have independent conversation context
- inherit the active model, effort, system prompt, steers, permission mode, and available tools
- cannot create nested subagents
- share confirmations through the main terminal UI
- report streaming progress and token usage
- allow up to five concurrent tasks

Tasks whose description indicates file changes attempt to use an isolated Git worktree. Agav applies the resulting changes back to the original checkout and reports a warning if that merge step fails. Read-only tasks use the current working directory directly.

Give a subagent all necessary paths, constraints, and expected output because it is instructed to work without follow-up questions.
