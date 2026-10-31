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

Tasks whose description indicates file changes attempt to use an isolated Git worktree. On successful completion, Agav commits remaining tracked edits and non-ignored new files, then merges the complete worker branch back into the original checkout. Worker directory and branch names include a unique suffix so retained work does not collide with workers in later sessions. If Git cannot create the worktree, the task stops with an error instead of running in the parent checkout. Read-only tasks and tasks outside Git repositories use the current working directory directly.

### Worktree delivery and recovery

Agav records the Git commit where each worker started. Delivery uses a normal merge commit, preserving all worker commits since that base along with any final uncommitted edits. An unchanged worker is a no-op; ignored files are excluded unless the worker explicitly tracks them. Both the parent and worker histories must still descend from the recorded base.

Automatic integration requires a clean parent index and tracked working files, with no merge, rebase, or cherry-pick in progress. Parent commits made while the worker runs are preserved. Agav previews the merge before modifying the parent, including directory-rename destinations, and checks local untracked and ignored files for collisions using filesystem identity. This also protects case-equivalent file and directory names on case-insensitive volumes. Automatic integration ignores `branch.<name>.mergeOptions` for its Git commands so preview and execution agree; the saved repository configuration is unchanged. Automatic integration requires Git with `merge-tree --write-tree` support; if the preview is unavailable or conflicts, work is retained for manual integration.

If staging, committing, or merging fails, the tool reports an error and retains the worker directory and branch. The error includes both names so you can inspect the output, resolve conflicts, or integrate it manually. For example, using the actual path and branch from the error:

```bash
git -C /path/from/error status
git -C /path/from/error diff HEAD
# After committing any remaining worker edits and preparing the parent checkout:
git merge --no-ff <branch-from-error>
```

Failed automatic merges are aborted. If Git cannot abort or roll back, the error also asks you to inspect the parent repository. Successful delivery removes only that worker's directory and branch. Cancellation discards worker output; if it arrives during integration, Agav rolls the merge back before cleanup. Once delivery has completed, cancellation does not undo it.

Give a subagent all necessary paths, constraints, and expected output because it is instructed to work without follow-up questions.

## Related

- [Create a Local Plugin](/guides/plugins) — step-by-step plugin authoring guide
- [Coordinate Parallel Subagents](/guides/parallel-agents) — patterns for splitting work across subagents
