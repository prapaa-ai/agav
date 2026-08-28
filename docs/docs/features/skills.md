---
title: Skills
description: Use, install, and create reusable Agav skill instructions
order: 3
---

# Skills

Skills are instruction packages stored in a directory containing `SKILL.md`. Agav loads bundled skills, then global skills from `~/.agav/skills`, then project skills from `./.agav/skills`. A project skill with the same slug overrides an earlier definition.

Agav includes skills for code review, diagnosis, documentation, explanation, refactoring, simplification, security scanning, research, commit messages, and test writing.

## Use skills

```text
/skills
/skills info code-review
/code-review review the staged changes
/security-scan src/auth
```

Skills with `invocation: both` can be selected automatically or called as slash commands. `agav` skills are automatic; `user` skills execute directly when invoked.

## Install and remove

```text
/skills add ./path/to/SKILL.md
/skills add https://example.com/SKILL.md
/skills marketplace
/skills marketplace 2
/skills remove skill-name
```

The marketplace currently lists skills from the public `anthropics/skills` repository and installs the selected `SKILL.md`. Restart Agav after installing or removing a skill.

## Create a skill

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
```

Supported frontmatter includes `name`, `description`, `version`, `invocation`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, and `tags`. Keep the body procedural and include the context required to complete the workflow. Agav validates imported skill Markdown before installing it.
