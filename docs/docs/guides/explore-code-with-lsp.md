---
title: Explore Code with LSP
description: Opt in to semantic code navigation through a scoped skill or native agent
navHidden: true
---

# Explore Code with LSP

`lsp_query` is an optional built-in, not a default main-session tool. Installing a language server alone does not enable it. Expose it in a skill's `allowed-tools` or a native agent's `native-tools`, then invoke that skill or agent.

## Create a read-only navigation skill

Create `.agav/skills/semantic-navigation/SKILL.md`:

```markdown
---
name: semantic-navigation
description: Trace definitions and references with a language server
version: 1.0.0
invocation: user
allowed-tools:
  - read_file
  - grep_search
  - find_files
  - lsp_query
---

# Semantic Navigation

1. Read the requested file and locate the symbol.
2. Use lsp_query definitions, references, and hover to trace its declaration and callers.
3. Verify the returned locations with focused file reads.
4. Explain the flow in execution order with evidence paths. Do not change files.
5. If the language server is unavailable, report that limitation and use text search and file reads without claiming semantic results.
```

Restart Agav to load the project skill, then invoke it explicitly:

```text
/semantic-navigation @counter.py find the increment function, trace its declaration and callers, and explain the execution order.
```

The optional tool is added to this skill's child registry; it does not become available in the main conversation. A skill without an explicit allowlist does not gain it, and `disallowed-tools` can still remove it.

## Native-agent alternative

For a native agent, include these entries in its `AGENT.md` frontmatter:

```yaml
native-tools:
  - read_file
  - grep_search
  - find_files
  - lsp_query
```

Invoke the configured agent for the navigation task. Native agents do not inherit the main session's built-ins; list every built-in the agent needs. See [the agent manifest reference](/reference/agent-manifest).

## Server requirements and limits

See [Built-in Tools](/features/built-in-tools#language-server-navigation) for supported language-server executables. The matching server must be on `PATH` in the shell that started Agav. Definitions, references, and hover complement file reads and repository search; diagnostic notifications are not yet fully surfaced, so run the project's normal diagnostic command for complete diagnostics.
