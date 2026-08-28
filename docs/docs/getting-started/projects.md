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

Project settings live in `./.agav/config.json` and override global defaults from `~/.agav/config.json`. Agav creates or enriches the project file without overwriting values already there.

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "effort": "medium",
  "permissionMode": "ask"
}
```

Do not commit API keys. Use provider environment variables or secure user-level configuration for credentials. See the [configuration reference](/reference/configuration) for every field and the full precedence rules.

## Know what is shared

| Item | Scope |
| --- | --- |
| `AGAV.md` or `.agavrc` | Repository instructions |
| `./.agav/config.json` | Project defaults |
| `~/.agav/config.json` | Defaults for your user account |
| `./.agav/skills` | Reusable procedures for this project |
| `~/.agav/skills` and `~/.agav/plugins` | User-level extensions |
| `~/.agav/history` | Saved interactive sessions |

You have completed the beginner path. Continue with [daily workflows](/workflows) or use the [task finder](/#find-what-you-need).
