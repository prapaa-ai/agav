---
title: Configure a Project
description: Set the workspace boundary, shared instructions, and project defaults
order: 5
---

# Configure a Project

You can use Agav without project configuration. Add it when a repository has conventions that Agav should follow consistently.

## Start at the project root

Agav treats the current directory as its workspace. Start from the repository root so file suggestions and tools can reach the whole project:

```bash
cd path/to/your-project
agav
```

`@file` paths are relative to this directory and cannot escape it through `..` or symlinks.

## Add repository instructions

Create `AGAV.md` or `.agavrc` at the project root. Agav uses the first non-empty file it finds.

```markdown
# Project instructions

- Use pnpm for JavaScript dependencies.
- Preserve the public API response format.
- Ask before changing database migrations.
```

Write short, actionable rules that apply across tasks. Put the details of a one-time task in its prompt instead.

## Save project defaults

Project settings live in `./.agav/config.json` and override global defaults from `~/.agav/config.json` (`%USERPROFILE%\.agav\config.json` on Windows). Agav creates or enriches the project file without overwriting values already there.

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "effort": "medium"
}
```

`permissionMode` is a global-only setting — set it in `~/.agav/config.json` or use `--auto-accept` / `--deny-writes` at startup. It cannot be set in project configuration to prevent untrusted repositories from silently escalating permissions.

MCP servers can be declared in project config so every session in the repository gets the same tools:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

Do not commit API keys. Use provider environment variables or secure user-level configuration for credentials. See the [configuration reference](/reference/configuration) for every field and the full precedence rules.

## Know what is shared

| Item | Scope |
| --- | --- |
| `AGAV.md` or `.agavrc` | Repository instructions |
| `./.agav/config.json` | Project defaults (provider, model, `mcpServers`, …) |
| `~/.agav/config.json` | Defaults for your user account |
| `./.agav/skills` | Reusable skill overrides for this project |
| `./.agav/agents` | Project-local agents |
| `~/.agav/skills`, `~/.agav/agents`, and `~/.agav/plugins` | User-level extensions |
| `~/.agav/projects/<hash>/memory` | Per-project memory, auto-saved across sessions |
| `~/.agav/history` | Saved interactive sessions |

> **Windows:** `~/.agav/` paths resolve to `%USERPROFILE%\.agav\` (e.g. `C:\Users\you\.agav\`).

Agav also ships with built-in skills (like `code-review`, `git-commit`, `test-writer`) that are always available. Project and user skills can override a built-in skill of the same name.

Per-project memory is keyed by a hash of the git root, so Agav remembers context about each repository without storing anything inside the repo itself. See [sessions and memory](/workflows/sessions-and-memory) for details.

You have completed the beginner path. Continue with [daily workflows](/workflows) or use the [task finder](/#find-what-you-need).
