---
title: Plugins and Subagents
description: Add local JavaScript tools and delegate parallel work
order: 5
---

# Plugins and Subagents

## Local plugins

Agav loads `.js` and `.mjs` files from `~/.agav/plugins` (`%USERPROFILE%\.agav\plugins` on Windows). A module can default-export one tool or export a `tools` array.

```javascript
export default {
  schema: {
    name: "project_status",
    description: "Return the current project status",
    inputSchema: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "Include extra detail" }
      }
    }
  },
  async execute(input) {
    const detail = input.verbose ? " (all systems nominal)" : "";
    return { output: `Ready${detail}`, isError: false }
  }
}
```

Each tool needs `schema.name`, `schema.description`, `schema.inputSchema`, and an async `execute(input)` function returning `{ output, isError }`. The `input` argument is an object with the properties defined in `inputSchema`. Broken plugin modules are skipped. Plugins execute local JavaScript with the same operating-system access as Agav, so install only code you trust and restart Agav after changes.

## Parallel subagents

The `subagent` tool delegates a clear, self-contained task with a short UI title. Subagents:

- have independent conversation context
- inherit the active model, effort, system prompt, steers, permission mode, and available tools
- can optionally run on a different model (see below)
- cannot create nested subagents
- share confirmations through the main terminal UI
- report streaming progress and token usage
- allow up to five concurrent tasks

### Running a subagent on a different model

A subagent accepts an optional `model` parameter. Omit it to use the active session model — the default. Set it only when you explicitly want a specific model for the delegated task; the requested model must exist and is subject to explicit per-call user approval. The requested model must also satisfy any organization policy that applies to the parent session (a managed model pin or allowlist), so a subagent cannot route inference around the policy through a different model or provider.

While subagents run, the terminal shows a live overview. Use `↑`/`↓` to select a subagent and `Enter` to inspect it. Press the cancel key (`Esc` by default) to cancel just the focused subagent while inspecting it, or to cancel all running subagents from the overview. See [Keybindings](/reference/keybindings) for the subagent navigation shortcuts.

Tasks whose description indicates file changes attempt to use an isolated Git worktree. Agav applies the resulting changes back to the original checkout and reports a warning if that merge step fails. Read-only tasks use the current working directory directly.

Give a subagent all necessary paths, constraints, and expected output because it is instructed to work without follow-up questions.

## Related

- [Create a Local Plugin](/guides/plugins) — step-by-step plugin authoring guide
- [Coordinate Parallel Subagents](/guides/parallel-agents) — patterns for splitting work across subagents
