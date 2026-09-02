---
title: Skills
description: Use, install, and create reusable Agav skill instructions
order: 3
---

# Skills

Skills are reusable instruction packages that extend Agav with domain-specific procedures. Each skill is a `SKILL.md` file — YAML front-matter declaring metadata, followed by a Markdown body containing the instructions the LLM follows when the skill is activated. Skills let you encode repeatable workflows (code review, test generation, research) and share them across projects and teams.

## Loading order

Skills are loaded from three tiers. A skill in a later tier with the same slug replaces the earlier definition:

| Tier | Location | Override priority |
|------|----------|-------------------|
| Bundled | Shipped with Agav binary | Lowest |
| Global | `~/.agav/skills/` | Middle |
| Project | `.agav/skills/` in the working directory | Highest |

When a project skill overrides a bundled or global skill, the override is tracked and shown as `(project, overrides bundled)` in `/skills list` and `/skills info`.

If two skills in the same tier share a slug, the second is skipped with a warning. Skills whose slug collides with a built-in command name (e.g. `help`, `plan`, `model`) are also silently skipped.

Bundled skills are compiled directly into the binary, so they work even when running from a compiled build where file system paths are unavailable.

## Bundled skills

Agav ships with 10 bundled skills:

| Skill | Description |
|-------|-------------|
| `code-review` | Review code changes for bugs, security issues, and improvements |
| `deep-research` | Multi-source research on a topic with citations |
| `diagnose` | Diagnose and fix errors and bugs |
| `doc-gen` | Generate documentation for code |
| `explain` | Explain code in plain language |
| `git-commit` | Generate a commit message from staged changes |
| `refactor` | Suggest and apply code refactoring |
| `security-scan` | Check code for security vulnerabilities |
| `simplify` | Reduce complexity and simplify code |
| `test-writer` | Generate unit tests for existing code |

## Using skills

Skills can be invoked in two ways depending on their `invocation` setting:

- **`user`** — called explicitly as a slash command: `/code-review src/auth.ts`
- **`agav`** — selected automatically by the LLM when a query matches the skill's triggers
- **`both`** — available both ways

```text
/code-review review the staged changes
/security-scan src/auth
/explain src/config/config.ts
```

### Automatic dispatch

When a user message starts with `[skill:<name>]`, Agav immediately activates that skill without planning. This is used internally by the LLM for automatic skill selection.

### Dynamic context variables

Skill bodies support two placeholder variables that are replaced at runtime:

- **`$ARGUMENTS`** — replaced with the user's arguments, or `"(no arguments)"` if none
- **`$CWD`** — replaced with the current working directory

### Steer integration

Active directives from `/steer` are appended to the skill's system prompt, so user guidance applies even inside skill execution.

## Installing skills

### From a local file or directory

```text
/skills add ./path/to/skill-dir
/skills add ./path/to/SKILL.md
```

When pointing to a directory, Agav copies the entire tree (excluding `.git`, `node_modules`, `.venv`, and `__pycache__`). When pointing to a bare SKILL.md file, it copies the file plus sibling asset directories (`scripts/`, `references/`, `assets/`) if present.

**Batch install:** If the target directory contains no `SKILL.md` at the root but has subdirectories with `SKILL.md` files, all subdirectories are installed independently. Failures in one skill don't block others.

**Size limits:** Installations are capped at 200 files and 10 MB total. Exceeding either limit is refused before any files are copied.

### From a URL

```text
/skills add https://github.com/org/repo/blob/main/skills/my-skill/SKILL.md
```

Agav normalizes common GitHub URL formats automatically:
- `github.com/.../blob/...` → raw content URL
- `github.com/.../tree/...` → raw content URL with `/SKILL.md` appended
- Bare repo URL → appends `/HEAD/SKILL.md`

If the URL returns an HTML page instead of Markdown, Agav reports a clear error rather than a confusing validation failure.

**GitHub batch install:** If a single URL 404s, Agav checks whether the URL points to a directory containing multiple skill subdirectories and installs all of them.

### From the marketplace

```text
/skills marketplace              # Browse available skills interactively
/skills marketplace 3            # Install skill #3 directly
```

The marketplace opens an interactive TUI:
- **↑↓** to navigate, **←→** to page (5 skills per page)
- **s** to search by name or description
- **ENTER** to install the selected skill
- **r** to refresh the catalog
- **ESC** to exit

Already-installed skills show a `✓ installed` badge and cannot be reinstalled.

### Removing skills

```text
/skills remove skill-name
/skills rm skill-name            # alias
/skills clear                    # remove ALL global skills
```

Restart Agav after installing or removing a skill.

## Creating a skill

A skill is a directory containing a `SKILL.md` file — YAML front-matter followed by instruction body:

```markdown
---
name: api-review
description: Review API changes for compatibility risks
version: 1.0.0
invocation: both
allowed-tools:
  - read_file
  - grep_search
tags:
  - api
  - review
---

# API Review

Inspect the requested API changes and report compatibility risks.

Check $ARGUMENTS for the files to review. Working directory is $CWD.
```

### Frontmatter fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique identifier. Must be lowercase with single hyphens (`my-skill`), max 64 chars. |
| `description` | string | yes | One-line description, max 1024 chars. |
| `version` | string | yes | Semver version string. |
| `invocation` | `user` \| `agav` \| `both` | no | How the skill can be triggered. Default: `both`. |
| `allowed-tools` | string[] | no | Whitelist of tools the skill can use. Supports parenthesized qualifiers like `Bash(npm run test:*)`. |
| `disallowed-tools` | string[] | no | Blacklist of tools removed from the skill's registry. |
| `model` | string | no | LLM model override for this skill. |
| `effort` | string | no | Reasoning effort override. |
| `tags` | string[] | no | Keywords for search and automatic trigger scoring. |
| `license` | string | no | License name or file reference. |
| `compatibility` | string | no | Environment requirements (max 500 chars). |
| `metadata` | Record | no | Arbitrary key-value pairs. Agav reads its own extension fields from here as a fallback, so skills authored for other platforms that nest extensions under `metadata:` work the same. |

### Tool name compatibility

The `allowed-tools` and `disallowed-tools` fields accept both Agav tool names and agentskills.io spec names. Spec names are automatically mapped at runtime:

| Spec name | Agav name |
|-----------|-----------|
| `Bash` | `run_command` |
| `Read` | `read_file` |
| `Write` | `write_file` |
| `Edit`, `MultiEdit` | `edit_file` |
| `Grep` | `grep_search` |
| `Glob` | `find_files` |
| `LS` | `list_directory` |
| `WebSearch` | `web_search` |
| `WebFetch` | `fetch_url` |
| `NotebookRead` | `read_notebook` |
| `NotebookEdit` | `edit_notebook` |
| `TodoRead`, `TodoWrite` | `update_plan` |

### Shell blocks

Skill bodies can contain fenced shell blocks (`` ```sh ``) that execute at runtime. Execution respects the active permission mode:

- **`deny-writes`** — shell blocks are always skipped
- **`ask`** — each block requires explicit user confirmation
- **`auto-accept`** — blocks execute without prompting

Shell blocks have a 10-second timeout. On Windows, they run via `cmd.exe /c`; on other platforms, `/bin/sh -c`.

## Execution sandboxing

Skills run with a restricted tool registry:
- Only tools listed in `allowed-tools` are available (or all tools if no whitelist is set)
- Tools listed in `disallowed-tools` are removed
- `subagent` and `activate_skill` are always removed — skills cannot nest or activate other skills

## Validation

Agav validates skills before installing or loading them. Validation checks include:

- **Required fields** — `name`, `description`, and `version` must be present
- **Name format** — must be lowercase with single hyphens, no leading/trailing hyphens
- **Directory name** — must match the skill `name` when installed in a dedicated directory
- **Size limits** — maximum 64 KB file size
- **Field length limits** — name ≤64 chars, description ≤1024 chars, compatibility ≤500 chars
- **Dangerous patterns** — blocks skills containing prompt injection strings (`ignore all previous instructions`), pipe-to-shell commands (`curl ... | bash`), `eval()`, `rm -rf /`, `chmod 777`, `sudo` piping, or `base64 | bash`
- **Tool name checks** — unknown tool names in `allowed-tools` and `disallowed-tools` produce warnings with "did you mean?" suggestions

Blocking failures prevent installation. Naming non-conformance produces warnings but the skill still loads.

## Skill improvement

Agav tracks skill usage and automatically evolves trigger matching over time:

- **Traces** — every skill execution is logged to `.agav/traces.jsonl` in the skill directory (timestamp, query snippet, tokens, success)
- **Statistics** — `/skills info <name>` shows total runs, average tokens per run, and success rate
- **Trigger phrases** — auto-generated positive and negative triggers from the skill's name, description, and tags
- **Trigger scoring** — user queries are scored against triggers to decide automatic activation (multi-word matches score higher, negative triggers reduce the score)
- **Optimization notes** — after 3+ runs, Agav generates suggestions (e.g., "tighten instructions to reduce token usage")
- **Background improvement** — every 15 turns, triggers, runtime prompts, and optimization notes are refreshed for all skills

## Related

- [Author and Evolve a Skill](/guides/create-search-skill) — full walkthrough
- [Compose Agents, Skills, and Tools](/guides/agent-skill-tool-combinations) — using skills with agents
