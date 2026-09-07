---
title: Author and Evolve a Skill
description: Turn a repeated repository review into a reusable procedure
guideLevel: advanced
order: 3
---

# Author and Evolve a Skill

Use a skill when you repeat the same procedure across several tasks.

## Scenario: review modules consistently

Create `.agav/skills/module-review/SKILL.md` in the hello-agav repository:

```markdown
---
name: module-review
description: Review a Python module against project conventions
version: 1.0.0
invocation: user
allowed-tools:
  - read_file
  - grep_search
  - find_files
---

# Module Review

1. Read the supplied module and identify its public functions.
2. Check for type annotations, docstrings, and error handling.
3. Find the corresponding test file in `tests/` and list untested paths.
4. Return a table with risk, evidence path, and recommendation.
5. Do not edit files.
```

Restart Agav, then run the skill manually:

```text
/module-review @counter.py
```

`invocation: user` keeps the workflow predictable: it runs only when you call it. The tool allowlist also keeps the review read-only.

## Improve it from real use

Inspect its configuration and usage:

```text
/skills info module-review
```

After several runs, change one instruction when you see a repeated problem — for example, add an edge-case check for malformed JSON if reviews keep missing it. Keep project skills in source control and review instruction changes like code.

## Expected result

Every module review follows the same checks and produces the same compact report format.

Next: [Compose Agents, Skills, and Tools](/guides/agent-skill-tool-combinations).
